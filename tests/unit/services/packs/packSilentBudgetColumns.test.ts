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
import { fitPageReport, OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { BUDGET_COLUMNS_DROPPED_NOTE } from '@/modules/accounting/services/packs/pages/packIncomeBudget';
import { fitRelaidPage } from '@/modules/accounting/services/packs/pages/packNarrativeFit';
import { relaidNarrative } from '@/modules/accounting/services/packs/pages/packNarrativeLayout';
import type { PackPage, PackPageBlock } from '@/modules/accounting/services/packs/pages/packPageModel';
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
    // (k=1 needed no omission note once the table was modelled at its exact height, so this shape is the net-debit one.)
    const { page } = p6({ tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 1000, plug: 0, sg: [-1, -1, 1, 1] });
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

describe('a plain fallback that fits untouched still says the columns are not printed (the adversary\'s advSilentBudgetFits)', () => {
  it('no trend panels, R1.0bn, plug 5%: the dropped-columns footnote prints, the derived caption pays for it', () => {
    const { page } = p6({ tr: 'none', budget: true, prior: true, negative: false, loss: false, k: 1000, plug: 0.05, sg: [-1, -1, 1, 1] });
    expect(hasColumns(page)).toBe(false);
    expect(page.footnotes.some((f) => f.text === BUDGET_COLUMNS_DROPPED_NOTE)).toBe(true);
    // The caption went to make room, so an omission note is printed beside the dropped-columns note. It never
    // claims every figure is complete (security review), and it does not name the columns a second time: the
    // page says they are not printed ONCE (the adversary's LOW).
    const omission = page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK))?.text;
    expect(omission, 'the caption was dropped, so the page says so').toContain('1 derived caption');
    expect(omission).not.toContain('Budget');
    expect(omission).not.toContain('Every figure, table and chart');
    expect(omission).toContain('Every other figure, table and chart on the page is complete');
    expect(page.footnotes.filter((f) => /Budget and Variance/.test(f.text))).toHaveLength(1);
  });
});

describe('the adversary\'s advNotedEveryFigure repro (the noted page)', () => {
  it('a page that leaves the Budget columns out never says every figure is complete', () => {
    const { page } = p6({ tr: 'none', budget: true, prior: true, negative: false, loss: false, k: 30000, plug: 0.05, sg: [1, -1, 1, -1] });
    const texts = page.footnotes.map((f) => f.text);
    expect(texts.some((t) => t.startsWith('The Budget and Variance columns are left out'))).toBe(true);
    expect(texts.filter((t) => /Every figure, table and chart on the page is complete/.test(t))).toEqual([]);
  });
});

describe('the budget probe and the real body fit are one function', () => {
  it('fitRelaidPage is what fitBodyPage applies: relaying changes nothing on page 6 (its caption has no board actions), so the probe and the real path agree', () => {
    const page = p6({ tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 1000, plug: 0.2, sg: [-1, 1, -1, -1] }).page;
    expect(fitRelaidPage(page).page).toBe(page);
    expect(relaidNarrative(page)).toBe(page);
  });
});

describe('a dropped caption is logged once, for the page used', () => {
  it.each<[string, Shape]>([
    ['budget company: the caption pays for the Budget columns', { tr: 'demo', budget: true, prior: true, negative: true, loss: false, k: 1000, plug: 0, sg: [-1, -1, 1, 1] }],
    ['no budget: the caption goes in fitBodyPage', { tr: 'demo', budget: false, prior: true, negative: true, loss: false, k: 1, plug: 0.2, sg: [1, 1, 1, 1] }],
  ])('%s', (unused, shape) => {
    const { page, warnings } = p6(shape);
    expect(page.footnotes.some((f) => f.text.includes('1 derived caption'))).toBe(true);
    expect(warnings.filter((w) => w.includes('derived caption'))).toHaveLength(1);
  });
});

describe('the column absence is said once on ANY path that puts the standalone note on the page', () => {
  // A hand-built page: the dropped-columns footnote and `columnsLeftOut`, set by no composer and with no
  // other flag, then crowded so the fit prints an omission note. The omission note must read the page.
  const SENTENCE = 'The prior column is the comparative period the basis page states, and a movement is never '
    + 'shown as a move from zero where that period carries no value for the measure.';
  const required: PackPageBlock = {
    kind: 'disclosure',
    disclosure: { heading: 'Lines below zero', required: true, notes: [{ heading: 'What this means', body: SENTENCE.repeat(27) }] },
  };
  const pageWith = (notes: string[]) => ({
    title: 'Revenue is below zero.', navLabel: 'Income statement', section: 'Financials' as const, orientation: 'portrait' as const, density: 'high' as const,
    blocks: [required], footnotes: notes.map((text, i) => ({ number: i + 1, text, ...(text === BUDGET_COLUMNS_DROPPED_NOTE ? { required: true as const } : {}) })),
    columnsLeftOut: ['Budget', 'Variance'],
  });

  it('names the columns once when the page carries the standalone note, and in the omission note when it does not', () => {
    const withNote = fitPageReport(pageWith([SENTENCE, SENTENCE, BUDGET_COLUMNS_DROPPED_NOTE]));
    const said = withNote.page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK))?.text ?? '';
    expect(withNote.dropped.footnotes, 'the fixture must make the fitter take an ordinary footnote').toBeGreaterThan(0);
    expect(withNote.page.footnotes.filter((f) => /Budget and Variance/.test(f.text))).toHaveLength(1);
    expect(said).not.toContain('Budget');
    expect(said).toContain('Every other figure, table and chart on the page is complete');
    const without = fitPageReport(pageWith([SENTENCE, SENTENCE, SENTENCE]));
    const named = without.page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK))?.text ?? '';
    expect(named).toMatch(/; the Budget and Variance columns\./);
  });
});
