/**
 * TWO REQUIRED DISCLOSURES, ONE HEADING, ONLY WHERE THE PAGE WOULD OTHERWISE BE REFUSED.
 *
 * Page 6 for a company with net-debit revenue AND another line below zero AND a material
 * interest/tax step carries "Lines below zero" (31.5mm) and "How much of this bridge is
 * unexplained" (31.5mm) as two blocks: the page needed 256 to 261mm of 255mm with everything the
 * fitter may take already gone (before prose was set at its own widths; now a page crowded further). Under one heading the two notes cost 9.8mm less, verbatim.
 *
 * The merged block is `neverTrim`: `fitPageToBox` step 3 abridges the tail of a required
 * disclosure with more than one note, and the tail here is the unexplained-step sentence the
 * integrity gate demands. A page that fits today is never merged.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { mergedDisclosures } from '@/modules/accounting/services/packs/pages/packIncomeSheet';
import { relaidNarrative } from '@/modules/accounting/services/packs/pages/packNarrativeLayout';
import { fitRelaidPage } from '@/modules/accounting/services/packs/pages/packNarrativeFit';
import { fitPageReport } from '@/modules/accounting/services/packs/pages/packPageFit';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import type { PackPage, PackPageBlock } from '@/modules/accounting/services/packs/pages/packPageModel';
import { crowdedPage6 } from './fixtures/page6Crowded';
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

describe('mergedDisclosures', () => {
  const req = (heading: string, ...notes: string[]): PackPageBlock =>
    ({ kind: 'disclosure', disclosure: { heading, required: true, notes: notes.map((n) => ({ heading: n, body: n })) } }) as PackPageBlock;

  it('merges EVERY disclosure block it is given, in order, under one neverTrim heading', () => {
    const merged = mergedDisclosures([req('A', 'a1', 'a2')], [req('B', 'b1'), req('C', 'c1')]);
    expect(merged).toHaveLength(1);
    const d = merged[0]!;
    expect(d.kind === 'disclosure' && d.disclosure).toMatchObject({ heading: 'Required disclosures', required: true, neverTrim: true });
    expect(d.kind === 'disclosure' && d.disclosure.notes.map((n) => n.heading)).toEqual(['a1', 'a2', 'b1', 'c1']);
  });

  it('leaves a lone disclosure alone, heading and all, and merges nothing when there is nothing', () => {
    const one = req('A', 'a1');
    expect(mergedDisclosures([one], [])).toEqual([one]);
    expect(mergedDisclosures([], [one])).toEqual([one]);
    expect(mergedDisclosures([], [])).toEqual([]);
  });

  it('refuses a block that is not a required disclosure rather than promote it to neverTrim', () => {
    const optional = { kind: 'disclosure', disclosure: { heading: 'O', notes: [{ heading: 'o', body: 'o' }] } } as PackPageBlock;
    expect(() => mergedDisclosures([req('A', 'a1')], [optional])).toThrow(PackRefusal);
    expect(() => mergedDisclosures([req('A', 'a1')], [optional])).toThrow(/only required disclosures merge/);
    expect(() => mergedDisclosures([req('A', 'a1')], [{ kind: 'narrative', narrative: { status: 'derived', body: 'x', actions: [] } }])).toThrow(/only required disclosures merge/);
  });
});

describe('neverTrim implies required', () => {
  it('a block flagged neverTrim alone is not an optional disclosure: its notes are not taken first', () => {
    const only = page([block('Req', 2, { neverTrim: true, required: undefined }), block('Optional', 2, { required: undefined })]);
    const { page: fitted, dropped } = fitPageReport(only);
    // The optional block pays; the neverTrim one keeps both notes.
    expect(dropped.notes).toBeGreaterThan(0);
    const kept = fitted.blocks[0]!;
    expect(kept.kind === 'disclosure' && kept.disclosure.notes).toHaveLength(2);
  });
});

const NET_DEBIT_ORDINARY: Page6Shape = { k: 1, negative: true, loss: false, plug: 0.2, sg: [1, 1, 1, 1] };
const p6Of = (shape: Page6Shape) => buildBoardPackPages(page6Input(shape)).pages.find((p) => p.navLabel === 'Income statement')!;
const headings = (p: Pick<PackPage, 'blocks'>) => p.blocks.flatMap((b) => (b.kind === 'disclosure' ? [b.disclosure.heading] : []));

describe('page 6', () => {
  // Scales 30 and 1,000 fit with both disclosures separate once the table is modelled at its exact height (4.4mm back),
  // and 300,000 once prose is set at its own widths: no shape of the 2,560 is refused apart now. The page is crowded by
  // a required footnote instead (`fixtures/page6Crowded`): two sentences of it fit apart, three only merged, five not.
  it('merges the two disclosures when the page would otherwise be refused, and only then', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      expect(headings(crowdedPage6(2, { budget: false }))).toEqual(['Lines below zero', 'How much of this bridge is unexplained']);
      const p6 = crowdedPage6(3, { budget: false });
      expect(pageMm(p6)).toBeLessThanOrEqual(pageBoxMm(p6));
      expect(headings(p6)).toEqual(['Required disclosures']);
      const merged = p6.blocks.find((b) => b.kind === 'disclosure');
      if (merged?.kind !== 'disclosure') throw new Error('no disclosure');
      expect(merged.disclosure).toMatchObject({ required: true, neverTrim: true });
      expect(merged.disclosure.notes.map((n) => n.heading)).toEqual(['What this means', 'Size of the unexplained step']);
      expect(merged.disclosure.notes[0]!.body).toMatch(/is below zero|are below zero/);
      expect(merged.disclosure.notes[1]!.body).toContain("'Other, not separately captured' accounts for");
      expect(() => crowdedPage6(5, { budget: false })).toThrow(PackRefusal);
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

describe('relaidNarrative is idempotent (incomeSheetWithBudget returns an already-relaid page, which fitBodyPage relays again)', () => {
  const action = 'The board is asked to approve the funding of the working capital facility described in the matters page, and to note the exposure it carries into the next quarter.';
  const narrativePage = (): Omit<PackPage, 'number'> => ({
    ...page([
      { kind: 'narrative', narrative: { status: 'derived', body: 'Revenue moved the most in money, down 450.', actions: [] }, boardActions: Array.from({ length: 14 }, () => action) } as PackPageBlock,
      block('Reading', 1, { required: undefined }),
    ]),
    footnotes: [],
  });

  it('on a page whose board-action narrative is restacked, a second relay changes nothing', () => {
    const once = relaidNarrative(narrativePage());
    const narrative = once.blocks.find((b) => b.kind === 'narrative');
    expect(narrative?.kind === 'narrative' && narrative.stackActions, 'the fixture is restacked by the first relay').toBe(true);
    expect(relaidNarrative(once)).toBe(once);
    expect(JSON.stringify(relaidNarrative(relaidNarrative(narrativePage())))).toBe(JSON.stringify(once));
  });

  it('and relaying the fitted page again is the same page (the fitter\'s own output is a fixed point)', () => {
    const { page: fitted } = fitRelaidPage(narrativePage());
    expect(fitRelaidPage(fitted).page).toBe(fitted);
  });
});
