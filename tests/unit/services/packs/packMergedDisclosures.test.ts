/**
 * TWO REQUIRED DISCLOSURES, ONE HEADING, ONLY WHERE THE PAGE WOULD OTHERWISE BE REFUSED.
 *
 * Page 6 for a company with net-debit revenue AND another line below zero AND a material
 * interest/tax step carries "Lines below zero" (31.5mm) and "How much of this bridge is
 * unexplained" (31.5mm) as two blocks: the page needs 256 to 261mm of 255mm with everything the
 * fitter may take already gone. Under one heading the two notes cost 9.8mm less, verbatim.
 *
 * The merged block is `neverTrim`: `fitPageToBox` step 3 abridges the tail of a required
 * disclosure with more than one note, and the tail here is the unexplained-step sentence the
 * integrity gate demands. A page that fits today is never merged.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { fitPageReport } from '@/modules/accounting/services/packs/pages/packPageFit';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import type { PackPage, PackPageBlock } from '@/modules/accounting/services/packs/pages/packPageModel';
import { page6Input, type Page6Shape } from './fixtures/page6Shapes';

const SENTENCE =
  'The prior column is the comparative period the basis page states, and a movement is never '
  + 'shown as a move from zero where that period carries no value for the measure.';
const page = (blocks: PackPageBlock[]): Omit<PackPage, 'number'> => ({
  title: 'T', navLabel: 'Income statement', section: 'Financials', orientation: 'portrait', density: 'high', blocks, footnotes: [],
});
const block = (heading: string, notes: number, extra: Record<string, unknown>): PackPageBlock => ({
  kind: 'disclosure',
  disclosure: { heading, required: true, notes: Array.from({ length: notes }, (unused, i) => ({ heading: `N${i + 1}`, body: SENTENCE.repeat(12) })), ...extra },
}) as PackPageBlock;

describe('fitPageToBox and a neverTrim disclosure', () => {
  it('abridges the tail of an ordinary required disclosure (the baseline)', () => {
    const { page: fitted, dropped } = fitPageReport(page([block('Req', 2, {}), block('Other', 1, {})]));
    expect(dropped.requiredNotes).toBeGreaterThan(0);
    const first = fitted.blocks[0]!;
    expect(first.kind === 'disclosure' && first.disclosure.notes).toHaveLength(1);
  });

  it('never abridges a neverTrim disclosure: the page is refused instead', () => {
    expect(() => fitPageReport(page([block('Req', 2, { neverTrim: true }), block('Other', 1, {})]))).toThrow(PackRefusal);
  });
});

const NET_DEBIT_TWO_LINES = (k: number): Page6Shape => ({ k, negative: true, loss: false, plug: 0.2, sg: [-1, 1, -1, -1] });
const NET_DEBIT_ORDINARY: Page6Shape = { k: 1, negative: true, loss: false, plug: 0.2, sg: [1, 1, 1, 1] };
const p6Of = (shape: Page6Shape) => buildBoardPackPages(page6Input(shape)).pages.find((p) => p.navLabel === 'Income statement')!;
const headings = (p: PackPage) => p.blocks.flatMap((b) => (b.kind === 'disclosure' ? [b.disclosure.heading] : []));

describe('page 6', () => {
  it.each([30, 1000, 300000])('merges the two disclosures when the page would otherwise be refused (scale %i)', (k) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const doc = buildBoardPackPages(page6Input(NET_DEBIT_TWO_LINES(k)));
      expect(() => assertPackIntegrity(doc)).not.toThrow();
      const p6 = doc.pages.find((p) => p.navLabel === 'Income statement')!;
      expect(pageMm(p6)).toBeLessThanOrEqual(pageBoxMm(p6));
      expect(headings(p6)).toEqual(['Required disclosures']);
      const merged = p6.blocks.find((b) => b.kind === 'disclosure');
      if (merged?.kind !== 'disclosure') throw new Error('no disclosure');
      expect(merged.disclosure).toMatchObject({ required: true, neverTrim: true });
      expect(merged.disclosure.notes.map((n) => n.heading)).toEqual(['What this means', 'Size of the unexplained step']);
      expect(merged.disclosure.notes[0]!.body).toMatch(/is below zero|are below zero/);
      expect(merged.disclosure.notes[1]!.body).toContain("'Other, not separately captured' accounts for");
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps two headed disclosures where the page fits without merging (#1148\'s shape)', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      expect(headings(p6Of(NET_DEBIT_ORDINARY))).toEqual(['Lines below zero', 'How much of this bridge is unexplained']);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the heading of a lone disclosure', () => {
    expect(headings(p6Of({ k: 1, negative: false, loss: false, plug: 0.2, sg: [1, 1, 1, 1] }))).toEqual(['How much of this bridge is unexplained']);
  });
});
