/**
 * PAGE 7 STATES THE POSITION THE WAY THE REST OF THE PLATFORM DOES.
 *
 * The balance sheet on screen, the AFS statement and the legacy pack all put
 * equity BEFORE liabilities and close on "Total Equity and Liabilities"
 * (`toBalanceSheetRows`, `toManagementBsRows`). The board pack printed
 * liabilities, then equity as its closing total, and no combined line — so a
 * director holding the pack beside the statement read two layouts of one
 * balance sheet, and the pack's never showed the figure that proves it foots.
 *
 * Read off the composed page, and the combined total is checked against the
 * figures the sheet prints rather than against the builder's own arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { toManagementBsRows } from '@/modules/accounting/services/reports/statementRows/packMappers';
import type { PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput, demoInput, figures } from './fixtures/boardPackInputs';
import { liveDemoInput } from './fixtures/liveDemoBoardPack';
import { POSITION_CHART_FLOOR_MM } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { CHART_HEIGHT_MM } from '@/lib/charts/ssrSvg';

function positionTable(input: BoardPackInput): PackTable {
  const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Balance sheet');
  expect(page, 'this pack has no balance sheet').toBeDefined();
  const block = page!.blocks.find((b) => b.kind === 'table');
  if (block === undefined || block.kind !== 'table') throw new Error('page 7 prints no table');
  return block.table;
}

const actualOf = (table: PackTable, label: string): number | null | undefined =>
  table.rows.find((row) => row.label === label)?.figures.actual?.value;

const COMPANIES: Record<string, BoardPackInput> = {
  'the fixture company': demoInput,
  'the demo company': liveDemoInput,
  Brightsphere: brightsphereLiveInput,
};

describe('page 7 — equity before liabilities, closing on their combined total', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`prints the rows in the statement's order on ${company}`, () => {
      expect(positionTable(input).rows.map((row) => row.label)).toEqual([
        'Current assets',
        'Non-current assets',
        'Total assets',
        'Total equity',
        'Current liabilities',
        'Non-current liabilities',
        'Total liabilities',
        'Total equity and liabilities',
      ]);
    });

    it(`closes on a total that is the equity and liabilities it prints, on ${company}`, () => {
      const table = positionTable(input);
      const closing = table.rows[table.rows.length - 1]!;
      expect(closing.role).toBe('total');
      expect(closing.figures.actual?.value).toBeCloseTo(
        input.set.current.totalEquity + input.set.current.totalLiabilities, 2,
      );
      // And it is the figure a reader checks against the asset side.
      expect(closing.figures.actual?.value).toBeCloseTo(actualOf(table, 'Total assets') as number, 2);
    });
  }

  it('orders the three totals the way the legacy pack statement does', () => {
    const legacy = toManagementBsRows({ totalAssets: 1, totalEquity: 1, totalLiabilities: 1 })
      .map((row) => row.label.toLowerCase());
    const board = positionTable(demoInput).rows
      .map((row) => row.label.toLowerCase())
      .filter((label) => legacy.includes(label));
    expect(board).toEqual(legacy);
  });

  it('carries the comparative on the closing total too', () => {
    const closing = positionTable(demoInput).rows.at(-1)!;
    const prior = demoInput.set.prior!;
    expect(closing.figures.prior?.value).toBeCloseTo(prior.totalEquity + prior.totalLiabilities, 2);
  });

  it('does not call the closing total a liability held below zero', () => {
    // "Total equity and liabilities" ENDS in "liabilities", and page 7's
    // "Balances below zero" block picks its liability rows by that ending.
    // On a company whose assets are negative the closing total is negative
    // with them, and it is not a balance anybody holds.
    const underwater: BoardPackInput = {
      ...demoInput,
      set: {
        ...demoInput.set,
        prior: null,
        current: figures({
          currentAssets: -500_000, totalAssets: -400_000,
          currentLiabilities: 100_000, totalLiabilities: 150_000, totalEquity: -550_000,
        }),
      },
    };
    const page = buildBoardPackPages(underwater).pages.find((p) => p.navLabel === 'Balance sheet')!;
    const below = page.blocks
      .flatMap((b) => (b.kind === 'disclosure' && b.disclosure.heading === 'Balances below zero'
        ? b.disclosure.notes.map((n) => n.body) : []))
      .join(' ');
    expect(below).toMatch(/total assets/i);
    expect(below).not.toMatch(/equity and liabilities/i);
  });
});

describe('the extra row is paid for by the chart, not by the page\'s footnotes', () => {
  // The live sheets carry the below-zero block AND the negative-equity
  // disclosure, and had under two millimetres spare: the eighth row pushed
  // the fitter into dropping all three footnotes, the trade-balances
  // memorandum among them.
  for (const [company, input] of Object.entries({ 'the demo company': liveDemoInput, Brightsphere: brightsphereLiveInput })) {
    it(`keeps every footnote on ${company}`, () => {
      const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Balance sheet')!;
      const notes = page.footnotes.map((f) => f.text).join(' ');
      expect(notes).not.toMatch(/Not printed on this page/);
      expect(notes).toMatch(/Memorandum: trade receivables/);
      const chart = page.blocks.find((b) => b.kind === 'chart');
      if (chart === undefined || chart.kind !== 'chart') throw new Error('page 7 draws no chart');
      expect(chart.chart.heightMm).toBeGreaterThanOrEqual(POSITION_CHART_FLOOR_MM);
      expect(chart.chart.heightMm).toBeLessThan(CHART_HEIGHT_MM.half);
    });
  }

  it('leaves a sheet that fits at the middle rung', () => {
    const page = buildBoardPackPages(demoInput).pages.find((p) => p.navLabel === 'Balance sheet')!;
    const chart = page.blocks.find((b) => b.kind === 'chart');
    expect(chart?.kind === 'chart' ? chart.chart.heightMm : null).toBe(CHART_HEIGHT_MM.half);
  });
});

describe('the closing total is held to the two totals above it', () => {
  function docWith(closing: number) {
    const p = new PackFigureProvenance();
    p.figure('packFigureSet.current.totalAssets', 3_900_000, 'money');
    p.figure('packFigureSet.current.totalLiabilities', 1_640_000, 'money');
    p.figure('packFigureSet.current.totalEquity', 2_260_000, 'money');
    p.figure('packStatementTables.totalEquityAndLiabilities', closing, 'money');
    const template = buildBoardPackPages(demoInput);
    return { ...template, provenance: p, pages: [], comparativePeriod: null };
  }

  it('refuses a closing total that is not equity plus liabilities', () => {
    expect(() => assertPackIntegrity(docWith(3_900_450)))
      .toThrow(/Total equity and liabilities does not equal total equity plus total liabilities/);
  });

  it('accepts it when it is', () => {
    expect(() => assertPackIntegrity(docWith(3_900_000))).not.toThrow();
  });
});
