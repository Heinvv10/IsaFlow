/**
 * THE TEXT-LAYER GATE READS A NON-BREAKING HYPHEN AS A HYPHEN.
 *
 * Titles are set with U+2011 between the parts of a compound so Chromium
 * cannot break the line there (`keepCompounds`), and `pdftotext` returns that
 * character, not "-". The gate compares the paper against the composed
 * document, which holds "-": every hyphenated chart or panel title would have
 * read as missing from the paper.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { checkPackTextLayer, packTextExpectations } from '@/modules/accounting/services/packs/figures/packTextLayer';
import { keepCompounds } from '@/components/accounting/packs/primitives/keepCompounds';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';

describe('the text-layer gate and the non-breaking hyphen', () => {
  it('passes paper that sets a title\'s compounds with U+2011', () => {
    const doc = buildBoardPackPages(brightsphereLiveInput);
    const expectations = packTextExpectations(doc);
    expect(expectations.some((e) => /\w-\w/.test(e.text)), 'no expectation carries a hyphenated compound').toBe(true);
    // The paper as Chromium sets it: every expectation on its sheet, each
    // compound joined by the non-breaking hyphen.
    const sheets = doc.pages.map((_page, i) => expectations.filter((e) => e.page === i + 1).map((e) => keepCompounds(e.text)).join('\n'));
    expect(checkPackTextLayer(doc, sheets.join('\f'))).toEqual([]);
  });
});
