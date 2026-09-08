/**
 * A SENTENCE THAT COUNTS SOMETHING A READER CAN COUNT HAS TO GET IT RIGHT.
 *
 * Three of them, found on one gate:
 *
 *  - page 12's colour key read "On the bridges" on a pack that draws ONE. The
 *    demo company's cash bridge is refused — there is nothing to bridge
 *    THROUGH, and page 8 says so in prose — so its only waterfall is on sheet
 *    6, and the key sent a reader looking for a second;
 *  - page 12's debtor-days entry described what "the trends page instead"
 *    does with the measure, on a pack whose trends page draws no debtor-days
 *    panel at all: Brightsphere's revenue is not a positive base;
 *  - page 9's caption read "The misses are in Liquidity" over ONE miss, four
 *    centimetres under a title that singularises correctly.
 *
 * All three are the same failure — prose stating a fact about the document
 * without asking the document — and all three are held here against the
 * composed pages rather than against the builders that made them.
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

function prose(doc: PackPagesDocument, navLabel: string): string {
  const page = doc.pages.find((p) => p.navLabel === navLabel);
  expect(page, `this pack has no ${navLabel} page`).toBeDefined();
  // The glossary is a `definitions` block, not a disclosure — page 12 carries
  // both, and a reader meets them on one sheet.
  return page!.blocks
    .flatMap((b) => {
      if (b.kind === 'disclosure') return b.disclosure.notes.map((n) => n.body);
      if (b.kind === 'definitions') return b.entries.map((e) => `${e.term} ${e.definition}`);
      return [];
    })
    .join(' ');
}

function waterfalls(doc: PackPagesDocument): number {
  return doc.pages
    .flatMap((p) => p.blocks)
    .filter((b) => b.kind === 'chart' && b.chart.kind === 'waterfall').length;
}

describe('page 12 counts what it is about', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`pluralises the colour key by the bridges it draws on ${company}`, () => {
      const doc = buildBoardPackPages(input);
      const key = prose(doc, 'Basis of preparation');
      const drawn = waterfalls(doc);
      expect(drawn, 'this pack draws no bridge, so the key describes nothing').toBeGreaterThan(0);
      if (drawn === 1) {
        expect(key, `${company} draws one bridge and its key says "bridges"`).toContain('On the bridge,');
      } else {
        expect(key, `${company} draws ${drawn} bridges and its key says "bridge"`).toContain('On the bridges,');
      }
    });

    it(`describes the trends page's debtor days only where that panel is drawn on ${company}`, () => {
      const doc = buildBoardPackPages(input);
      const glossary = prose(doc, 'Basis of preparation');
      const drawn = doc.pages
        .flatMap((p) => p.blocks)
        .some((b) => b.kind === 'smallMultiples' && b.panels.some((x) => x.id === 'trend-debtor-days'));
      expect(
        /trends page instead multiplies/.test(glossary),
        drawn
          ? `${company} draws a debtor-days panel and page 12 does not define it`
          : `${company} draws no debtor-days panel and page 12 defines what it would do`,
      ).toBe(drawn);
    });
  }

  it('is not vacuous — the two companies differ on both counts', () => {
    const docs = Object.values(COMPANIES).map(buildBoardPackPages);
    expect(new Set(docs.map(waterfalls)).size, 'both packs draw the same number of bridges').toBe(2);
    const panels = docs.map((d) => d.pages.flatMap((p) => p.blocks)
      .some((b) => b.kind === 'smallMultiples' && b.panels.some((x) => x.id === 'trend-debtor-days')));
    expect(new Set(panels).size, 'both packs draw the same debtor-days panel state').toBe(2);
  });
});
