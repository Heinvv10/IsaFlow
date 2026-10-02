/**
 * PAGE 8'S INVESTING LINE IS NET INVESTING, WHERE THE PACK HAS IT.
 *
 * The cash table and the bridge both took investing as capital expenditure,
 * negated, and nothing else. The figure set now carries the cash flow
 * statement's own net investing figure — disposals included — and a pack
 * holding that and no capex figure printed the row as `n/m` and drew the
 * whole investing flow as "Unexplained movement".
 *
 * One reading, `investingCashFlowOf`, for the row and the bar: the statement's
 * figure where there is one, capital expenditure negated where there is not,
 * and nothing where there is neither.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCashWaterfallChart,
  CASH_UNCAPTURED_LABEL,
} from '@/modules/accounting/services/packs/pages/packPageCharts';
import { buildCashTable } from '@/modules/accounting/services/packs/pages/packStatementTables';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { cashCaption } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import { demoSet, figures } from './fixtures/boardPackInputs';

// Cents that foot exactly and do not foot in a double.
const OPENING = 1_787_567.21;
const OPERATING = 345_678.12;
const INVESTING = -98_765.43;
const FINANCING = 12_345.67;
const CLOSING = 2_046_825.57;

const setOf = (current: Partial<ReportPackFigures>): PackFigureSet => ({
  ...demoSet,
  prior: figures({ cash: OPENING, capitalExpenditure: undefined }),
  current: figures({
    cash: CLOSING, operatingCashFlow: OPERATING, financingCashFlow: FINANCING,
    capitalExpenditure: undefined, ...current,
  }),
});

const investingRow = (set: PackFigureSet) =>
  buildCashTable(set, new PackFigureProvenance()).rows.find((r) => r.label === 'Investing cash flow')!;

const barLabels = (set: PackFigureSet): string[] => {
  const bridge = buildCashWaterfallChart(set, PACK_SCALE);
  if (!bridge.drawn) throw new Error(`no bridge was drawn: ${bridge.why}`);
  return bridge.chart.waterfallBars!.map((bar) => bar.label);
};

describe('investing from the cash flow statement, with no capital expenditure figure', () => {
  const set = setOf({ investingCashFlow: INVESTING });

  it('is figures that foot in cents and not in a double', () => {
    expect(CLOSING - OPENING - (OPERATING + INVESTING + FINANCING)).not.toBe(0);
    const cents = (n: number) => Math.round(n * 100);
    expect(cents(OPENING) + cents(OPERATING) + cents(INVESTING) + cents(FINANCING)).toBe(cents(CLOSING));
  });

  it('prints the row at that figure', () => {
    expect(investingRow(set).figures.actual?.value).toBe(INVESTING);
  });

  it('draws opening, three flows and closing, and no "Unexplained movement"', () => {
    expect(barLabels(set)).toEqual(['Opening cash', 'Operating', 'Investing', 'Financing', 'Closing cash']);
  });

  it('still draws the bar on a set that genuinely does not foot', () => {
    expect(barLabels(setOf({ investingCashFlow: INVESTING, cash: CLOSING + 5_000 })))
      .toContain(CASH_UNCAPTURED_LABEL);
  });

  it('prefers it to capital expenditure where the pack has both', () => {
    // Net of a disposal: 150 000 spent, 51 234.57 raised.
    const both = setOf({ investingCashFlow: INVESTING, capitalExpenditure: 150_000 });
    expect(investingRow(both).figures.actual?.value).toBe(INVESTING);
    expect(barLabels(both)).not.toContain(CASH_UNCAPTURED_LABEL);
  });
});

describe('the fallbacks', () => {
  it('takes capital expenditure, negated, where there is no investing figure', () => {
    const capexOnly = setOf({ capitalExpenditure: 98_765.43 });
    expect(investingRow(capexOnly).figures.actual?.value).toBe(INVESTING);
    expect(barLabels(capexOnly)).toEqual(['Opening cash', 'Operating', 'Investing', 'Financing', 'Closing cash']);
  });

  it('prints a reason, and draws no Investing bar, where there is neither', () => {
    const neither = setOf({});
    const actual = investingRow(neither).figures.actual;
    expect(actual?.value).toBeNull();
    // The row's own noun, and no claim that investing IS capital expenditure.
    expect(actual?.unavailable).toBe('No investing cash flow figure was captured for this period.');
    expect(barLabels(neither)).not.toContain('Investing');
    expect(barLabels(neither)).toContain(CASH_UNCAPTURED_LABEL);
  });

  it('reads the comparative the same way', () => {
    const set: PackFigureSet = {
      ...setOf({ investingCashFlow: INVESTING }),
      prior: figures({ cash: OPENING, capitalExpenditure: undefined, investingCashFlow: -40_000 }),
    };
    expect(investingRow(set).figures.prior?.value).toBe(-40_000);
  });
});

/**
 * "NOT CAPTURED" AND "COULD NOT BE READ" ARE TWO STATEMENTS.
 *
 * When the cash flow read itself fails the three figures are left unset, and
 * page 8 said "No operating cash flow figure was captured for this period."
 * — true, and it reads as a company with no cash flows. The figure set now
 * carries the reason the read failed; the rows and the caption print it.
 */
describe('a cash flow statement that could not be read', () => {
  const NOT_READ = 'The cash flow statement could not be read for this period.';
  const unread = (): PackFigureSet => {
    const base = setOf({});
    return {
      ...base,
      current: {
        ...base.current,
        operatingCashFlow: undefined, financingCashFlow: undefined, cashFlowUnavailable: NOT_READ,
      },
    };
  };
  const reasons = (set: PackFigureSet): Array<string | undefined> =>
    buildCashTable(set, new PackFigureProvenance()).rows
      .filter((r) => /^(Operating|Investing|Financing) cash flow$/.test(r.label))
      .map((r) => r.figures.actual?.unavailable);

  it('says so on all three flow rows', () => {
    expect(reasons(unread())).toEqual([NOT_READ, NOT_READ, NOT_READ]);
  });

  it('says so in the caption, not that no figure was captured', () => {
    const caption = cashCaption(unread(), null, PACK_SCALE);
    expect(caption).toBe(NOT_READ);
  });

  it('keeps "not captured" for a statement that was read and carries no figure', () => {
    const base = setOf({});
    const set: PackFigureSet = {
      ...base, current: { ...base.current, operatingCashFlow: undefined, financingCashFlow: undefined },
    };
    expect(reasons(set)).toEqual([
      'No operating cash flow figure was captured for this period.',
      'No investing cash flow figure was captured for this period.',
      'No financing cash flow figure was captured for this period.',
    ]);
    expect(cashCaption(set, null, PACK_SCALE)).toBe('No operating cash flow figure was captured for this period.');
  });

  it('gives the comparative cells the comparative\'s own reason', () => {
    const base = setOf({ investingCashFlow: INVESTING });
    const set: PackFigureSet = {
      ...base,
      prior: {
        ...base.prior!, operatingCashFlow: undefined, financingCashFlow: undefined, cashFlowUnavailable: NOT_READ,
      },
    };
    const operating = buildCashTable(set, new PackFigureProvenance()).rows.find((r) => r.label === 'Operating cash flow')!;
    expect(operating.figures.actual?.value).toBe(OPERATING);
    // Named as the comparative's, since the column is a different period.
    expect(operating.figures.prior?.unavailable).toBe("The comparative period's cash flow statement could not be read.");
  });
});
