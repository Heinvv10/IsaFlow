/**
 * PAGE 12 STATES WORKING CAPITAL IN THE UNIT IT IS PRINTED IN.
 *
 * The definition read "Current assets less current liabilities, in rand." on
 * every board pack, while the highlights tile and page 7's commentary print
 * the figure at the pack's scale — Velocity Fibre's (48 746) is R'000, so a
 * reader taking page 12 at its word read a R48 746 shortfall where the books
 * say R48.7m.
 *
 * Read off the composed document: the definition page 12 prints, against the
 * scale the basis states for the whole pack.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';

function definitionOf(page: PackPage, term: string): string {
  for (const block of page.blocks) {
    if (block.kind !== 'definitions') continue;
    const entry = block.entries.find((e) => e.term === term);
    if (entry !== undefined) return entry.definition;
  }
  throw new Error(`page ${page.number} defines no "${term}"`);
}

const PACKS: Array<[string, BoardPackInput]> = [
  ['the demo company', demoInput],
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['Brightsphere as the live route composed it', brightsphereLiveInput],
];

describe('the working capital definition on page 12', () => {
  for (const [name, input] of PACKS) {
    it(`names the scale the figure is printed at — ${name}`, () => {
      const doc = buildBoardPackPages(input);
      const basis = doc.pages[doc.pages.length - 1]!;
      const definition = definitionOf(basis, 'Working capital');

      expect(definition).not.toMatch(/\brands?\b/);
      expect(definition).toContain(doc.numberConvention.scale);
    });
  }
});
