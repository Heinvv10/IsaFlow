/**
 * WHEN THE FITTER DROPS A FOOTNOTE IT TAKES THE SUPERSCRIPT WITH IT.
 *
 * Before: a dropped footnote left its row's / column's superscript printed, pointing at nothing,
 * and the omission note then took the number past the highest survivor -- which could be the very
 * number a surviving superscript printed, so the Gross profit row's "5" pointed at "Not printed on
 * this page". After: the dropped note's anchors are removed, the survivors are renumbered 1..n and
 * every superscript left points at the note about its row or column.
 *
 * The 2,560-input sweep over every page is `packFitterAnchorsSweep.test.ts`; this is the unit
 * level, on a page built to make the fitter drop footnotes (a required note last, so the ordinary
 * ones before it go and leave a gap).
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { fitPageReport, OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import type { PackFootnote, PackPage, PackPageBlock, PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoInput } from './fixtures/boardPackInputs';
import { anchorsOf, fitterFaults, numberingFaults } from './fixtures/packAnchors';

const SENTENCE =
  'The prior column is the comparative period the basis page states, and a movement is never '
  + 'shown as a move from zero where that period carries no value for the measure.';

/** Page 6's real table, with its own anchors replaced by `anchors`: row index -> footnote number. */
function tableAnchoredAt(rows: Record<number, number>, columnNotes: PackTable['columnNotes']): PackPageBlock {
  const income = buildBoardPackPages(demoInput).pages.find((p) => p.navLabel === 'Income statement')!;
  const block = income.blocks.find((b) => b.kind === 'table')!;
  if (block.kind !== 'table') throw new Error('page 6 has no table');
  const table: PackTable = {
    ...block.table,
    rows: block.table.rows.map(({ footnote: unused, ...row }, i) => (rows[i] === undefined ? row : { ...row, footnote: rows[i] })),
    columnNotes,
  };
  return { kind: 'table', table };
}

const requiredBlock = (notes: number): PackPageBlock => ({
  kind: 'disclosure',
  disclosure: {
    heading: 'Negative equity', required: true,
    notes: Array.from({ length: notes }, (unused, i) => ({ heading: `Note ${i + 1}`, body: SENTENCE })),
  },
});

/** Five footnotes: 1-4 ordinary, 5 required. Row 0 -> 1, row 1 -> 2, rows 2 and 3 -> 3, row 4 -> 4, prior column -> 5. */
function crowdedPage(): PackPage {
  const text = (n: number) => `Footnote ${n} is about its own anchor. ${SENTENCE}`;
  const footnotes: PackFootnote[] = [1, 2, 3, 4, 5].map((n) => ({ number: n, text: text(n), ...(n === 5 ? { required: true as const } : {}) }));
  return {
    number: 6, title: 'Income statement', navLabel: 'Income statement', section: 'Financials', orientation: 'portrait', density: 'high',
    blocks: [tableAnchoredAt({ 0: 1, 1: 2, 2: 3, 3: 3, 4: 4 }, [{ column: 'prior', footnote: 5 }]), requiredBlock(10)],
    footnotes,
  };
}

/** What each anchor prints beside, as text. */
const resolved = (page: PackPage) => {
  const byNumber = new Map(page.footnotes.map((f) => [f.number, f.text]));
  return Object.fromEntries(anchorsOf(page).map((a) => [a.at, byNumber.get(a.n)?.slice(0, 10) ?? `(no footnote ${a.n})`]));
};

describe('a footnote the fitter drops takes its superscript with it', () => {
  const subject = crowdedPage();
  const { page: fitted, dropped } = fitPageReport(subject);

  it('the fixture makes the fitter drop ordinary footnotes and fits the sheet (so the rest means something)', () => {
    expect(pageMm(subject)).toBeGreaterThan(pageBoxMm(subject));
    expect(dropped.footnotes).toBeGreaterThanOrEqual(1);
    expect(pageMm(fitted)).toBeLessThanOrEqual(pageBoxMm(fitted));
    // The required footnote survives; ordinary ones went, so a gap needed closing.
    expect(fitted.footnotes.some((f) => f.text.startsWith('Footnote 5'))).toBe(true);
    expect(fitted.footnotes.some((f) => f.text.startsWith('Footnote 4'))).toBe(false);
    expect(fitted.footnotes.some((f) => f.text.startsWith('Footnote 3'))).toBe(false);
    expect(fitted.footnotes.some((f) => f.text.startsWith('Footnote 2'))).toBe(true);
  });

  it('removes the anchors of the dropped footnotes: no superscript points at nothing', () => {
    expect(numberingFaults(fitted)).toEqual([]);
    // Row 4 was anchored to the dropped footnote 4, rows 2 and 3 to the dropped footnote 3.
    expect(Object.keys(resolved(fitted)).sort()).toEqual(
      ['table is.revenue column prior', 'table is.revenue row is.costOfSales', 'table is.revenue row is.revenue']);
  });

  it('renumbers the survivors 1..n, and the omission note takes the next number', () => {
    const numbers = fitted.footnotes.map((f) => f.number);
    expect(numbers).toEqual(numbers.map((unused, i) => i + 1));
    const said = fitted.footnotes.filter((f) => f.text.startsWith(OMISSION_MARK));
    expect(said).toHaveLength(1);
    expect(said[0]!.number).toBe(fitted.footnotes.length);
    // Nothing anchors the omission note.
    expect(anchorsOf(fitted).map((a) => a.n)).not.toContain(said[0]!.number);
  });

  it('every surviving superscript still points at the note it pointed at before the fit', () => {
    expect(fitterFaults(subject, fitted)).toEqual([]);
    const after = resolved(fitted);
    const before = resolved(subject);
    for (const [at, text] of Object.entries(after)) expect(text, at).toBe(before[at]);
    // The prior column's note was 5 and is now 3: its anchor moved with it.
    expect(after['table is.revenue column prior']).toBe('Footnote 5');
    expect(anchorsOf(fitted).find((a) => a.at.endsWith('column prior'))!.n).toBe(3);
  });

  it('a page that already fits comes back unchanged, numbers and all', () => {
    const fits: PackPage = { ...crowdedPage(), blocks: [crowdedPage().blocks[0]!] };
    expect(pageMm(fits)).toBeLessThanOrEqual(pageBoxMm(fits));
    const out = fitPageReport(fits);
    expect(out.page).toBe(fits);
    expect(out.page.footnotes.map((f) => f.number)).toEqual([1, 2, 3, 4, 5]);
  });
});
