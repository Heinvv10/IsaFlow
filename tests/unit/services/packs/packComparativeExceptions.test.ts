/**
 * THE EXCEPTION LIST OMITTED ONE OF ITS OWN ITEMS, AND THE PACK PROVED IT
 * TWICE.
 *
 * Page 10 reads "…on the scorecard page — against the comparative but gross
 * margin". Page 9 disproves it: the demo pack prints Debtor days PRIOR as
 * `n/m` — the same state as gross margin's — and every other measure the
 * sentence names does carry a prior. Page 3 gives the two identical
 * treatment, and Brightsphere's counterpart sentence correctly needs no
 * exception and has none.
 *
 * `printsAgainstComparative` was the whole test, and it is a STRUCTURAL fact:
 * page 6 has no comparative column for a ratio it prints in `% of revenue`.
 * Whether the cell a reader turns to actually carries a figure is a second
 * fact, and this holds the sentence to both — read off the composed pages
 * rather than declared in a table, so a measure whose prior is not meaningful
 * this period joins the list without anyone remembering to.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoShortPanelsInput,
  Brightsphere: brightsphereLiveInput,
};

/** Page 10's Period note, as the sheet composes it. */
function periodNote(doc: PackPagesDocument): string {
  const page = doc.pages.find((p) => p.navLabel === 'Trends');
  expect(page, 'this pack has no trends page').toBeDefined();
  // By its HEADING, not by a phrase in its body: the body is prose this
  // branch keeps shortening, and a finder that matches on wording silently
  // returns nothing the next time a word is spent.
  const body = page!.blocks
    .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []))
    .find((n) => n.heading === 'Period');
  return body?.body ?? '';
}

/** Whether page 9's scorecard prints a PRIOR figure for a metric. */
function scorecardPrior(doc: PackPagesDocument, metric: string): boolean {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'scorecard') continue;
      const row = block.groups.flatMap((g) => g.rows).find((r) => r.metric.toLowerCase() === metric);
      if (row === undefined) return false;
      return row.prior !== undefined && row.prior.value !== null;
    }
  }
  return false;
}

describe('page 10 excepts every measure whose comparative cell is empty', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`agrees with the scorecard about debtor days on ${company}`, () => {
      const doc = buildBoardPackPages(input);
      const note = periodNote(doc);
      if (note === '' || !note.includes('debtor days')) return; // no panel, nothing claimed

      const printed = scorecardPrior(doc, 'debtor days');
      const excepted = /except [^.]*debtor days/.test(note);
      expect(
        excepted,
        printed
          ? `page 9 prints a debtor-days prior and page 10 calls it an exception: ${note}`
          : `page 9 prints no debtor-days prior and page 10 claims it is against the comparative: ${note}`,
      ).toBe(!printed);
    });
  }

  it('is not vacuous — one company has an empty comparative cell and the other has none', () => {
    const states = Object.entries(COMPANIES).map(([name, input]) => {
      const doc = buildBoardPackPages(input);
      return [name, periodNote(doc).includes('debtor days'), scorecardPrior(doc, 'debtor days')] as const;
    });
    expect(states.some(([, drawn, prior]) => drawn && !prior), 'no fixture reaches the defect').toBe(true);
  });

  it('states no exception at all where every cell carries one', () => {
    // The mirror: Brightsphere's sentence needs no exception and must not
    // manufacture one. A guard that always names something is the same defect
    // pointing the other way.
    const note = periodNote(buildBoardPackPages(brightsphereLiveInput));
    if (note === '') return;
    const measures = ['revenue', 'operating expenses', 'net profit', 'cash'];
    const allPrinted = measures.every((m) => note.includes(m));
    if (!allPrinted) return;
    expect(note, 'Brightsphere excepts a measure its own sheets print a prior for')
      .not.toMatch(/except [^.]*(revenue|operating expenses|net profit)/);
  });
});
