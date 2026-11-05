/**
 * A PAGE 6 THAT LEAVES THE BUDGET COLUMNS OUT NEVER CLAIMS EVERY FIGURE IS PRINTED.
 *
 * When the fitter rescues a budget company's page 6 only after `incomeSheetWithBudget` has composed it
 * without the Budget and Variance columns, the omission note ("Not printed on this page: ...") used to
 * say nothing about the columns and ended "Every figure, table and chart on the page is complete" --
 * false: eight Budget and Variance figures are issued and unprinted. The standalone "left out of this
 * page" footnote still prints only where the page carries it (the #1121 ruling); but whenever an
 * omission note IS printed on such a page it names the columns and says "every OTHER figure".
 *
 * And a caption dropped inside `incomeSheetWithBudget`'s own fit is logged once, for the page used.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import { input, type Shape } from './fixtures/page6Grid';

const p6 = (shape: Shape): { page: PackPage; warnings: string[] } => {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  try {
    const page = buildBoardPackPages(input(shape)).pages.find((p) => p.navLabel === 'Income statement')!;
    return { page, warnings: warn.mock.calls.map((c) => String(c[0])) };
  } finally {
    warn.mockRestore();
  }
};
const hasColumns = (page: PackPage) => page.blocks.some((b) => b.kind === 'table' && b.table.columns.includes('budget'));

describe('the omission note on a budget company\'s page 6 that has no budget columns', () => {
  it.each<[string, Shape]>([
    ['net-debit revenue, the #1148 rescue', { tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 1, plug: 0.05, sg: [-1, 1, 1, 1] }],
  ])('%s: names the columns, and does not say every figure is complete', (unused, shape) => {
    const { page } = p6(shape);
    expect(hasColumns(page)).toBe(false);
    const note = page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK))?.text;
    expect(note, 'no omission note on a page that lost columns').toBeDefined();
    expect(note).toMatch(/; the Budget and Variance columns\./);
    expect(note).not.toContain('Every figure, table and chart');
    expect(note).toContain('Every other figure, table and chart on the page is complete');
  });

  it('merged disclosures, the #1154 rescue: names the columns too', () => {
    const { page } = p6({ tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 1000, plug: 0.05, sg: [1, -1, -1, -1] });
    expect(hasColumns(page)).toBe(false);
    expect(page.blocks.some((b) => b.kind === 'disclosure' && b.disclosure.heading === 'Required disclosures')).toBe(true);
    const note = page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK))?.text;
    expect(note).toMatch(/; the Budget and Variance columns\./);
    expect(note).not.toContain('Every figure, table and chart');
  });

  it('a company with no budget is not told about columns it never had', () => {
    const { page } = p6({ tr: 'demo', budget: false, prior: true, negative: true, loss: false, k: 1, plug: 0.05, sg: [-1, 1, 1, 1] });
    const note = page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK))?.text;
    expect(note).toBeDefined();
    expect(note).not.toContain('Budget');
    expect(note).toContain('Every figure, table and chart on the page is complete');
  });

  it('a budget company whose columns print keeps the plain wording', () => {
    const { page } = p6({ tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 1, plug: 0.05, sg: [-1, -1, 1, 1] });
    expect(hasColumns(page)).toBe(true);
    const note = page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK))?.text;
    expect(note).not.toContain('Budget');
    expect(note).toContain('Every figure, table and chart on the page is complete');
  });

  it('the fitter\'s instruction does not reach the document', () => {
    const doc = buildBoardPackPages(input({ tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 1, plug: 0.05, sg: [-1, 1, 1, 1] }));
    expect(JSON.stringify(doc.pages)).not.toContain('columnsLeftOut');
  });
});

describe('a dropped caption is logged once, for the page used', () => {
  it.each<[string, Shape]>([
    ['budget company: the caption pays for the Budget columns', { tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 1, plug: 0.05, sg: [-1, -1, 1, 1] }],
    ['no budget: the caption goes in fitBodyPage', { tr: 'demo', budget: false, prior: true, negative: true, loss: false, k: 1, plug: 0.2, sg: [1, 1, 1, 1] }],
  ])('%s', (unused, shape) => {
    const { page, warnings } = p6(shape);
    expect(page.footnotes.some((f) => f.text.includes('1 derived caption'))).toBe(true);
    expect(warnings.filter((w) => w.includes('derived caption'))).toHaveLength(1);
  });
});
