/**
 * NET-DEBIT REVENUE WITH A MATERIAL INTEREST/TAX STEP GETS ITS BOARD PACK.
 *
 * Page 6 for that company carries the table with its two not-meaningful reasons (82.5mm), the
 * bridge at its 48mm floor, two required disclosures (the lines below zero and the unexplained
 * step, 26 to 31mm each) and the required sign-flip footnote: 261 to 266mm in a 255mm box, with
 * every optional note and ordinary footnote taken, and `fitPageToBox` refused the whole pack at
 * every scale. The one block left that the pack is not bound to make is the derived
 * "largest mover" caption; it goes as the last lever and the page says so.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import { demoInput } from './fixtures/boardPackInputs';
import { page6Input, type Page6Shape } from './fixtures/page6Shapes';

const NET_DEBIT = (k: number, loss: boolean, plug = 0.2): Page6Shape => ({ k, negative: true, loss, plug, sg: [1, 1, 1, 1] });

describe.each([1, 30, 1000, 300000])('net-debit revenue and a 20%% interest/tax step at scale %s', (k) => {
  it.each([false, true])('is composed into a pack (loss=%s) whose page 6 fits its sheet', (loss) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const doc = buildBoardPackPages(page6Input(NET_DEBIT(k, loss)));
      expect(() => assertPackIntegrity(doc)).not.toThrow();
      expect(doc.pages).toHaveLength(12);
      const p6 = doc.pages.find((p) => p.navLabel === 'Income statement')!;
      expect(pageMm(p6)).toBeLessThanOrEqual(pageBoxMm(p6));

      // Everything that carries a figure or a statutory reason is still on the page.
      const table = p6.blocks.find((b) => b.kind === 'table');
      expect(table?.kind === 'table' && table.table.rows.map((r) => r.key)).toEqual(
        ['is.revenue', 'is.costOfSales', 'is.grossProfit', 'is.operatingExpenses', 'is.otherIncome', 'is.operating', 'is.otherExpenses', 'is.netProfit']);
      expect(p6.blocks.some((b) => b.kind === 'chart')).toBe(true);
      const headings = p6.blocks.flatMap((b) => (b.kind === 'disclosure' ? [b.disclosure.heading] : []));
      expect(headings).toEqual(['Lines below zero', 'How much of this bridge is unexplained']);
      expect(p6.footnotes.some((f) => f.required === true)).toBe(true);

      // What it gave up, said on the page and logged.
      expect(p6.blocks.some((b) => b.kind === 'narrative')).toBe(false);
      const said = p6.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
      expect(said?.text).toContain('1 derived caption');
      // Logged once, for the page that is used (the probe fits stay silent).
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('derived caption'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the same company without the interest/tax step', () => {
  it('keeps its caption and drops nothing', () => {
    const p6 = buildBoardPackPages(page6Input(NET_DEBIT(1, false, 0))).pages.find((p) => p.navLabel === 'Income statement')!;
    expect(p6.blocks.some((b) => b.kind === 'narrative')).toBe(true);
    expect(p6.footnotes.some((f) => f.text.startsWith(OMISSION_MARK))).toBe(false);
  });
});

describe('no figure changes', () => {
  const tableOf = (shape: Page6Shape) => {
    const p6 = buildBoardPackPages(page6Input(shape)).pages.find((p) => p.navLabel === 'Income statement')!;
    const t = p6.blocks.find((b) => b.kind === 'table');
    if (t?.kind !== 'table') throw new Error('no table');
    return t.table;
  };

  it('every figure on the table is the one the input states, whether or not the caption is printed', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      for (const k of [1, 1000]) {
        const input = page6Input(NET_DEBIT(k, false));
        const printed = tableOf(NET_DEBIT(k, false));
        const c = input.set.current;
        const actual = Object.fromEntries(printed.rows.map((r) => [r.key, r.figures.actual?.value]));
        expect(actual).toEqual({
          'is.revenue': c.revenue, 'is.costOfSales': c.costOfSales, 'is.grossProfit': c.revenue - c.costOfSales,
          'is.operatingExpenses': c.operatingExpenses, 'is.otherIncome': c.otherIncome,
          'is.operating': c.operatingProfit, 'is.otherExpenses': c.otherExpenses, 'is.netProfit': c.netProfit,
        });
        // And every row but net profit has the actual, prior and change cells of the table the same
        // company gets with no step (which fits, and also prints Budget and Variance).
        const without = tableOf(NET_DEBIT(k, false, 0));
        const rows = (t: typeof printed) => t.rows.filter((r) => r.key !== 'is.netProfit')
          .map((r) => [r.key, r.figures.actual?.value, r.figures.prior?.value, r.figures.change?.value]);
        expect(rows(printed).map(([key]) => key)).toEqual(rows(without).map(([key]) => key));
        expect(rows(printed)).toEqual(rows(without));
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the demo company', () => {
  it('prints page 6 with its caption, as before', () => {
    const p6 = buildBoardPackPages(demoInput).pages.find((p) => p.navLabel === 'Income statement')!;
    expect(p6.blocks.some((b) => b.kind === 'narrative')).toBe(true);
  });
});
