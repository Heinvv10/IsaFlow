/**
 * THE BASIS OF PREPARATION IS NOT PROSE THE PAGE MAY ECONOMISE ON.
 *
 * Page 12 exists to say what standard the figures were prepared under, from
 * which system, at what scale, read when, and against which ledger state.
 * `fitPageToBox` trims a page by taking the trailing notes of the disclosures
 * it does not have to make, cheapest first — and on the live demo and
 * Brightsphere ledgers those trailing notes were `Currency and rounding`,
 * `Source system`, `Rounding`, `Extracted at` and `Ledger version`. Five of
 * the eight facts the page is for, with a footer reading "Not printed on this
 * page: 5 explanatory notes, from 'Basis of preparation'". The rendered pack
 * carried no ledger version at all.
 *
 * They were taken to pay for millimetres that were not on the paper: the
 * browser lays that page out at 253.8mm in a 255mm box on BOTH companies, and
 * the composer read it at 262.2mm. See `DEFINITION_BRIDGE_ROW_MM` and
 * `disclosureMm` for the two over-charges, and `packSheetCount.test.ts` for
 * the assertion that the corrected model is still never short of Chromium.
 *
 * WHY THE ASSERTION IS THE HEADINGS AND NOT A COUNT. A count passes on a page
 * that prints eight notes because it kept the five cheap ones and dropped
 * three; what a reader loses is the specific fact, so the specific fact is
 * what is named.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import {
  brightsphereInput,
  demoInput,
  denseInput,
  noRatioPanelsInput,
} from './fixtures/boardPackInputs';
import { liveDemoInput } from './fixtures/liveDemoBoardPack';

const FIXTURES: Record<string, BoardPackInput> = {
  demo: demoInput,
  brightsphere: brightsphereInput,
  dense: denseInput,
  'no ratio panels': noRatioPanelsInput,
  // The one that reproduced it. This fixture carried ONE caveat where the
  // live company has two — it has no account classified as inventory, so
  // `buildPackFigureSet` returns that caveat on every render — and a caveat
  // is five lines of the tightest prose page in the pack. Six centimetres of
  // page 12 the suite could not see. See its `inventoryCaveat`.
  live: liveDemoInput,
};

/** Every fact `buildBasisPage` puts on the page, by the heading it prints. */
const BASIS_FACTS = [
  'Standard',
  'Period',
  'Comparative period',
  'Currency and rounding',
  'Source system',
  'Rounding',
  'Extracted at',
  'Ledger version',
];

describe('page 12 never trims the basis of preparation', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`prints all eight basis facts on ${name}`, () => {
      const page = buildBoardPackPages(input).pages.at(-1)!;
      expect(page.navLabel).toBe('Basis of preparation');
      const basis = page.blocks.find(
        (b) => b.kind === 'disclosure' && b.disclosure.heading === 'Basis of preparation',
      );
      expect(basis, 'the basis block is not on the page at all').toBeDefined();
      const printed = basis!.kind === 'disclosure' ? basis!.disclosure.notes.map((n) => n.heading) : [];
      expect(printed).toEqual(BASIS_FACTS);
    });

    it(`withholds nothing from ${name}'s basis page`, () => {
      const page = buildBoardPackPages(input).pages.at(-1)!;
      const said = page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK));
      expect(said?.text ?? null).toBeNull();
    });
  }
});

/**
 * AND THE DENOMINATOR THE TRENDS PANELS CITE IS NOT PROSE EITHER.
 *
 * Page 10's panels are titled "Own scale — 1.1% of the shared range" and a
 * caption reads "drop it and the shared range shrinks by 52.4%". What the
 * shared range IS was stated only in the page's Scale note, which the fitter
 * may take — and on the live demo company it takes it, leaving three
 * percentages of an undisclosed denominator on the sheet. It is now stated in
 * the page's commentary block, which `fitPageToBox` never touches.
 */
describe('page 10 states the range its percentages are taken against', () => {
  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`on ${name}`, () => {
      const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Trends');
      if (page === undefined) return;
      const citesShare = page.blocks.some((b) => b.kind === 'smallMultiples'
        && b.panels.some((panel) => panel.title.includes('of the shared range')));
      if (!citesShare) return;
      const narrative = page.blocks.find((b) => b.kind === 'narrative');
      expect(
        narrative?.kind === 'narrative' ? narrative.narrative.body : null,
        'a panel claims a share of the shared range and no unbudgeted block states what it is',
      ).toMatch(/shared y-scale spans/);
    });
  }
});
