/**
 * THE GLOSSARY IS WHAT THE PACK PRINTS.
 *
 * A blind gate read page 12 against the eleven sheets in front of it and
 * found the list had come loose from the document three ways at once:
 * `Net profit margin` was defined on both companies and printed on neither;
 * `Financing cash flow` was printed on page 8 of both and defined nowhere,
 * while the row above it was defined on page 12 and the row above THAT was
 * explained only in a footnote — three bands of one statement, three
 * treatments; and `Inventory days` was used inside the cash-conversion-cycle
 * definition and defined nowhere at all.
 *
 * None of the three is a typo. They are what a hand-maintained list does
 * against a document that changes, and the branch has already fixed one
 * instance of it by hand — the debtor-days entry that described a trends
 * panel Brightsphere does not draw. So the list is now filtered by what the
 * composed body actually prints, and these hold both directions of that:
 * nothing defined that is not printed, and nothing printed that is not
 * defined.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  definitionsPrintedBy, NOTATION_TERMS, TERMS_COVERING,
} from '@/modules/accounting/services/packs/pages/packDefinitions';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';
import type { PackPage, PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoShortPanelsInput,
  Brightsphere: brightsphereLiveInput,
};

/** Everything the eleven sheets before the glossary print, lower-cased. */
function bodyProse(doc: PackPagesDocument): string {
  const out: string[] = [];
  const skip = new Set(['svg', 'sparklineSvg', 'trendSvg', 'bulletSvg', 'kind', 'type', 'id']);
  const walk = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) { if (!skip.has(key)) walk(inner); }
    }
  };
  for (const page of doc.pages) {
    if (page.number === doc.pages.length) continue;
    walk({ t: page.title, n: page.navLabel, b: page.blocks, f: page.footnotes });
  }
  return out.join('  ').toLowerCase();
}

function glossary(doc: PackPagesDocument): string[] {
  return doc.pages.at(-1)!.blocks
    .flatMap((b) => (b.kind === 'definitions' ? b.entries.map((e) => e.term) : []));
}

/** The row labels page 8's cash statement prints — read off the composed
 *  table, because the question is what a reader sees on that sheet. */
function cashRows(doc: PackPagesDocument): string[] {
  const page = doc.pages.find((p: PackPage) => p.navLabel === 'Cash')!;
  return page.blocks.flatMap((b) => (b.kind === 'table'
    ? b.table.rows.map((r) => r.label).filter((l) => /cash flow$/i.test(l))
    : []));
}

describe('page 12 defines what the pack prints, and only that', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`defines no measure ${company}'s pack does not print`, () => {
      const doc = buildBoardPackPages(input);
      const printed = bodyProse(doc);
      const terms = glossary(doc);
      expect(terms.length, 'the glossary is empty, so nothing is being checked')
        .toBeGreaterThan(8);
      for (const term of terms) {
        if (NOTATION_TERMS.has(term)) continue;
        const covers = TERMS_COVERING[term] ?? [term];
        expect(
          covers.some((label) => printed.includes(label.toLowerCase())),
          `${company}: page 12 defines "${term}" and no sheet of the pack prints it`,
        ).toBe(true);
      }
    });

    it(`defines every band of the cash statement on ${company}`, () => {
      // THE OTHER DIRECTION, asked of the document rather than of a list.
      // Page 8 prints three cash-flow rows and only one of them was defined.
      const doc = buildBoardPackPages(input);
      const rows = cashRows(doc);
      expect(rows.length, 'page 8 prints no cash-flow rows, so nothing is being checked').toBe(3);
      const defined = glossary(doc).flatMap((term) => TERMS_COVERING[term] ?? [term]);
      for (const row of rows) {
        expect(defined, `${company}: page 8 prints "${row}" and page 12 defines no such thing`)
          .toContain(row);
      }
    });
  }

  it('drops a measure the pack stops printing, and keeps the notation whatever happens', () => {
    // The filter itself, on a shape neither company has: an entry for a
    // measure nobody prints, beside the notation entries that are not
    // measures at all. `Negative figures` is nowhere in the body as a phrase
    // — a reader meets the convention it describes on nine sheets — so a
    // filter that treated it like a measure would delete the key to the
    // document.
    const entries = [
      { term: 'Negative figures', definition: 'x' },
      { term: 'Gross margin', definition: 'y' },
      { term: 'Net profit margin', definition: 'z' },
    ];
    const kept = definitionsPrintedBy(entries, 'the gross margin is 12%').map((e) => e.term);
    expect(kept).toEqual(['Negative figures', 'Gross margin']);
  });

  it('keeps an entry that covers printed labels its own term is not', () => {
    // One entry defines page 8's three rows under a heading that is none of
    // them. Matched on the term alone it would be filtered out as a
    // definition of something the pack does not print, which is the opposite
    // of true.
    const term = 'Operating, investing and financing cash flow';
    expect(TERMS_COVERING[term]).toContain('Financing cash flow');
    const kept = definitionsPrintedBy([{ term, definition: 'x' }], 'financing cash flow n/m');
    expect(kept.map((e) => e.term)).toEqual([term]);
    expect(definitionsPrintedBy([{ term, definition: 'x' }], 'nothing here')).toEqual([]);
  });

  it('defines every term its own definitions use', () => {
    // `Inventory days` appeared only INSIDE the cash-conversion-cycle
    // definition — a term used in a definition and defined nowhere, on the
    // page whose job is to define terms. It is not a measure the pack prints,
    // so it is defined where it is used rather than given an entry on the
    // tightest sheet in the pack.
    const doc = buildBoardPackPages(liveDemoShortPanelsInput);
    const cycle = doc.pages.at(-1)!.blocks
      .flatMap((b) => (b.kind === 'definitions' ? b.entries : []))
      .find((e) => e.term === 'Cash conversion cycle');
    expect(cycle, 'the pack no longer defines the cash conversion cycle').toBeDefined();
    expect(cycle!.definition).toContain('inventory days (inventory over cost of sales, times 365)');
  });
});
