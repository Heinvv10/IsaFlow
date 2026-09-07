/**
 * SHEET 5 WAS 80% A SHORTER COPY OF SHEET 6, AND HALF A BLANK PAGE.
 *
 * It printed Revenue, Gross profit, Operating profit, EBITDA and Net profit
 * against the prior period; four of those five rows print again on sheet 6,
 * against the same comparative, and the sheet ended at 48% of the paper.
 * These hold the replacement to the two things that make it worth a sheet:
 * that no row of it is a row sheet 6 states against the same comparative, and
 * that every row adds across — which is the only reason a reader can be asked
 * to trust a fourth expense column they cannot see anywhere else.
 *
 * The EBITDA row was the ONE row of the old table sheet 6 did not print, so it
 * was never the duplication; it stays on sheet 5 as a stated memorandum, and
 * the last test here is that it did not quietly leave the pack with it.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMonthlyResultsTable,
  ebitdaMemoSentence,
  monthlyResultsCaption,
  monthlyResultsTitle,
  trendWindowLabel,
} from '@/modules/accounting/services/packs/pages/packMonthlyResults';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { liveDemoRenderedInput, liveDemoTrend } from './fixtures/liveDemoBoardPack';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

/** A series whose OTHER INCOME and below-the-operating-line bands are both
 *  non-nil — the two small columns that make each row add across, and the two
 *  a fixture of zeros cannot prove. */
const withBelowLine: PackTrendPoint[] = liveDemoTrend.map((point, i) => ({
  ...point,
  revenue: 100_000 + i * 1_000,
  otherIncome: 2_000 + i * 50,
  costOfSales: 40_000,
  operatingExpenses: 30_000,
  // expenses − costOfSales − operatingExpenses is the below-the-line band.
  expenses: 40_000 + 30_000 + (5_000 + i * 100),
  netProfit: (100_000 + i * 1_000) + (2_000 + i * 50) - (40_000 + 30_000 + (5_000 + i * 100)),
}));

const table = (trend: PackTrendPoint[]) => buildMonthlyResultsTable(trend, new PackFigureProvenance());

describe('sheet 5\'s month-by-month results', () => {
  it('states no comparative column, because its rows are months', () => {
    const t = table(withBelowLine);
    expect(t.columns).not.toContain('prior');
    expect(t.columns).not.toContain('change');
    expect(t.columns).not.toContain('changePct');
    expect(t.columns).not.toContain('actual');
  });

  it('adds across on every row, the two small bands included', () => {
    const t = table(withBelowLine);
    expect(t.rows.length).toBe(withBelowLine.length + 1);
    for (const row of t.rows) {
      const v = (key: string) => row.figures[key as keyof typeof row.figures]!.value!;
      expect(
        v('revenue') + v('otherIncome') - v('costOfSales') - v('monthOperatingExpenses') - v('otherExpenses'),
        row.label,
      ).toBeCloseTo(v('netProfit'), 6);
    }
  });

  /**
   * THE REVENUE COLUMN IS THE STATEMENT'S REVENUE. It was every revenue
   * account, other income included, so Brightsphere printed (5 536) here
   * against (5 535) on the income statement one sheet later — the same figure,
   * measured twice. `packTrendBanding.test.ts` holds the service side; this
   * holds the sheet, which is where a director met it.
   */
  it('prints turnover in the revenue column and other income in its own', () => {
    const t = table(withBelowLine);
    const march = t.rows[2]!;
    expect(march.figures.revenue!.value).toBe(withBelowLine[2]!.revenue);
    expect(march.figures.otherIncome!.value).toBe(withBelowLine[2]!.otherIncome);
    expect(march.figures.revenue!.value).not.toBe(
      withBelowLine[2]!.revenue + withBelowLine[2]!.otherIncome,
    );
  });

  it('sums each column into the window row, and names the window rather than calling it a total', () => {
    const t = table(withBelowLine);
    const window = t.rows[t.rows.length - 1]!;
    expect(window.role).toBe('total');
    expect(window.label).toBe(trendWindowLabel(withBelowLine));
    expect(window.label).not.toMatch(/total/i);
    const months = t.rows.slice(0, -1);
    for (const key of ['revenue', 'otherIncome', 'costOfSales', 'monthOperatingExpenses', 'otherExpenses', 'netProfit'] as const) {
      const summed = months.reduce((sum, row) => sum + row.figures[key]!.value!, 0);
      expect(window.figures[key]!.value, key).toBeCloseTo(summed, 6);
    }
  });

  it('is a table of no months, and says so in words, where there is no series', () => {
    expect(table([]).rows).toEqual([]);
    expect(monthlyResultsTitle([], PACK_SCALE)).toContain('0 months');
    expect(monthlyResultsCaption([], PACK_SCALE)).toContain('No monthly series');
  });

  /**
   * BRIGHTSPHERE IS THE COMPANY A MARGIN PAGE WOULD HAVE EMPTIED. Its revenue
   * over the window is not a positive base, so a share of it is not a
   * measurement — the caption states the figures and refuses the percentage
   * rather than printing a flattering one, and every cell of the table still
   * carries a number.
   */
  it('states figures rather than a share where the window\'s revenue is not a positive base', () => {
    const negative: PackTrendPoint[] = withBelowLine.map((p) => ({ ...p, revenue: -10_000 }));
    const caption = monthlyResultsCaption(negative, PACK_SCALE);
    expect(caption).toContain('not a positive base');
    expect(caption).not.toMatch(/% of it/);
    for (const row of table(negative).rows) {
      for (const figure of Object.values(row.figures)) expect(figure!.value).not.toBeNull();
    }
  });

  it('titles the sheet with the spread of net profit across the months it shows', () => {
    const title = monthlyResultsTitle(withBelowLine, PACK_SCALE);
    expect(title).toMatch(/Net profit runs from .+ in .+ to .+ in .+/);
    const flat: PackTrendPoint[] = withBelowLine.map((p) => ({ ...p, netProfit: 0 }));
    expect(monthlyResultsTitle(flat, PACK_SCALE)).toContain('nil');
  });
});

describe('the pack\'s one non-IFRS measure', () => {
  it('is still presented, and identified as non-IFRS where it is presented', () => {
    for (const [name, input] of [['demo', liveDemoRenderedInput], ['brightsphere', brightsphereLiveInput]] as const) {
      const page5 = buildBoardPackPages(input).pages.find((p) => p.number === 5)!;
      const notes = page5.blocks
        .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []))
        .map((n) => `${n.heading} ${n.body}`);
      const ebitda = notes.find((n) => n.includes('EBITDA'));
      expect(ebitda, `${name} sheet 5 states no EBITDA`).toBeDefined();
      expect(ebitda, name).toContain('not because a standard requires it');
      expect(ebitda, name).toContain('depreciation and amortisation');
    }
  });

  it('states the period\'s figure and its comparative, never a bare dash', () => {
    const sentence = ebitdaMemoSentence(liveDemoRenderedInput.set, PACK_SCALE);
    expect(sentence).toMatch(/EBITDA for the reporting period is /);
    expect(sentence).not.toMatch(/is –/);
    const noPrior = ebitdaMemoSentence(
      { ...liveDemoRenderedInput.set, prior: null },
      PACK_SCALE,
    );
    expect(noPrior).toContain('no comparative period');
  });
});

/**
 * THE DUPLICATION ITSELF, held structurally: no row label sheet 5 prints may
 * be a row label sheet 6 prints. It was Revenue, Gross profit, Operating
 * profit and Net profit on both, against the same two periods.
 */
describe('sheets 5 and 6 do not print one statement twice', () => {
  it('shares no row label between them, on either company', () => {
    for (const [name, input] of [['demo', liveDemoRenderedInput], ['brightsphere', brightsphereLiveInput]] as const) {
      const doc = buildBoardPackPages(input);
      const labels = (n: number) => new Set(doc.pages.find((p) => p.number === n)!.blocks
        .flatMap((b) => (b.kind === 'table' ? b.table.rows.map((r) => r.label) : [])));
      const five = labels(5);
      expect(five.size, name).toBeGreaterThan(0);
      for (const label of labels(6)) {
        expect(five.has(label), `${name}: "${label}" prints on both sheets`).toBe(false);
      }
    }
  });
});
