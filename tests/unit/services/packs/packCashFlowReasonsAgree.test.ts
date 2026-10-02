/**
 * PAGES 8 AND 9 STATE ONE ABSENT CASH FLOW FIGURE ONE WAY.
 *
 * Operating cash flow prints on the cash page's table and on the scorecard,
 * under the same source. Where the comparative window had no operating figure
 * the two worded its absence differently — "The comparative period carries no
 * figure for this line…" against "In the comparative period: no operating cash
 * flow figure was captured…" — and the consistency gate, which compares the
 * reason as well as the value, refused the pack. A tenant whose prior cash
 * flow read degraded could not print a board pack at all.
 *
 * Every combination of a missing or unread window, composed: the pack builds,
 * and each source prints one sentence on both pages.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import { CASH_FLOW_NOT_READ } from '@/modules/accounting/services/reports/reportPackDataService';
import { liveDemoInput } from './fixtures/liveDemoBoardPack';

const flows = (f: ReportPackFigures, operating: number): ReportPackFigures =>
  ({ ...f, operatingCashFlow: operating, investingCashFlow: 0, financingCashFlow: 0, cashFlowUnavailable: null });
const absent = (f: ReportPackFigures): ReportPackFigures =>
  ({ ...f, operatingCashFlow: undefined, investingCashFlow: undefined, financingCashFlow: undefined, cashFlowUnavailable: null });
const unread = (f: ReportPackFigures): ReportPackFigures =>
  ({ ...absent(f), cashFlowUnavailable: CASH_FLOW_NOT_READ });

const base = liveDemoInput;
const movement = base.set.current.cash - base.set.prior!.cash;
const withSet = (current: ReportPackFigures, prior: ReportPackFigures): BoardPackInput =>
  ({ ...base, set: { ...base.set, current, prior } });

const CASES: Array<[string, BoardPackInput]> = [
  ['current flows, comparative has none', withSet(flows(base.set.current, movement), absent(base.set.prior!))],
  ['current flows, comparative statement unread', withSet(flows(base.set.current, movement), unread(base.set.prior!))],
  ['current statement unread, comparative flows', withSet(unread(base.set.current), flows(base.set.prior!, -51_000))],
  ['both unread', withSet(unread(base.set.current), unread(base.set.prior!))],
];

/** Every operating-cash-flow cell, by source, on the page that prints it. */
function cells(input: BoardPackInput): Array<{ page: string; figure: PackFigure }> {
  const out: Array<{ page: string; figure: PackFigure }> = [];
  for (const page of buildBoardPackPages(input).pages) {
    for (const block of page.blocks) {
      const figures = block.kind === 'table'
        ? block.table.rows.flatMap((r) => Object.values(r.figures))
        : block.kind === 'scorecard'
          ? block.groups.flatMap((g) => g.rows.flatMap((r) => [r.actual, r.prior]))
          : [];
      for (const figure of figures) {
        if (figure?.source.startsWith('packFigureSet.current.operatingCashFlow')) out.push({ page: page.navLabel, figure });
      }
    }
  }
  return out;
}

describe('an absent operating cash flow is stated one way on every page', () => {
  it.each(CASES)('%s: the pack composes', (_name, input) => {
    expect(() => buildBoardPackPages(input)).not.toThrow();
  });

  it.each(CASES)('%s: both pages print the same reason for each cell', (_name, input) => {
    const found = cells(input);
    expect(new Set(found.map((c) => c.page)), 'the figure prints on both pages').toEqual(new Set(['Cash', 'Scorecard']));
    for (const source of new Set(found.map((c) => c.figure.source))) {
      const reasons = new Set(found.filter((c) => c.figure.source === source).map((c) => c.figure.unavailable));
      expect(reasons.size, `${source}: ${[...reasons].join(' | ')}`).toBe(1);
    }
  });

  it('says the comparative statement could not be read, where that is why', () => {
    const prior = cells(CASES[1]![1]).find((c) => c.figure.source.endsWith('.prior'))!;
    expect(prior.figure.unavailable).toMatch(/comparative period's cash flow statement could not be read/);
  });

  it('says the comparative carries no figure, where the statement was read', () => {
    const prior = cells(CASES[0]![1]).find((c) => c.figure.source.endsWith('.prior'))!;
    expect(prior.figure.unavailable).not.toMatch(/could not be read/);
    expect(prior.figure.unavailable).toMatch(/comparative period/i);
  });

  it('states a reason true of both periods once, so page 9 carries one note', () => {
    const both = cells(CASES[3]![1]);
    expect(new Set(both.map((c) => c.figure.unavailable)).size).toBe(1);
  });
});
