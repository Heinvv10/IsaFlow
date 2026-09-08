/**
 * THE COVER CARRIES THE FACT THAT GOVERNS ALL TWELVE SHEETS.
 *
 * Brightsphere's cover printed the DRAFT status and the part-month note, and
 * left the caveat that decides how the whole document reads — nothing posted
 * to the ledger since 29 April, five of the period's months nil because the
 * ledger has not moved — until page 2. A director who read only the cover met
 * "1 January 2026 to 7 September 2026" with no hint that four of those months
 * are empty.
 *
 * The convention was symmetric across both packs, so it was a design choice
 * rather than an inconsistency: the cover carried preparation and period and
 * nothing conditional on the ledger. The choice is wrong here. A caveat that
 * qualifies the period the cover states belongs on the cover, and it is the
 * same sentence pages 2 and 4 already carry — `ledgerStalenessCaveat`, one
 * wording — printed conditionally, so a company whose ledger reaches the
 * period end is unaffected.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { ledgerStalenessCaveat } from '@/modules/accounting/services/packs/pages/packLedgerCurrency';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';

/** Every note the cover prints, as `heading — body`. */
function coverNotes(doc: PackPagesDocument): string[] {
  return doc.pages[0]!.blocks.flatMap((b) => (b.kind === 'disclosure'
    ? b.disclosure.notes.map((n) => `${n.heading} — ${n.body}`)
    : []));
}

const caveatOf = (input: BoardPackInput): string | null => ledgerStalenessCaveat(
  input.ledgerVersion, input.trend, input.set.currentWindow.end,
);

describe('the cover states how far the ledger reaches', () => {
  it('prints the ledger caveat on the company whose ledger stops mid-period', () => {
    const caveat = caveatOf(brightsphereLiveInput);
    expect(caveat, 'the fixture ledger reaches the period end, so nothing is being checked')
      .not.toBeNull();
    const notes = coverNotes(buildBoardPackPages(brightsphereLiveInput));
    expect(notes.some((n) => n.includes(caveat!)),
      `the cover says nothing about the ledger: ${notes.join(' / ')}`).toBe(true);
    // The SAME sentence page 2 carries, not a second wording of it — the two
    // are one claim about one ledger.
    const contents = buildBoardPackPages(brightsphereLiveInput).pages[1]!;
    const caveats = contents.blocks.flatMap((b) => (b.kind === 'disclosure'
      ? b.disclosure.notes.map((n) => n.body) : []));
    expect(caveats).toContain(caveat);
  });

  it('names the month and the count a reader needs off the cover alone', () => {
    const notes = coverNotes(buildBoardPackPages(brightsphereLiveInput)).join(' ');
    // The two facts the cover was missing: WHEN the ledger stops, and how
    // much of the stated period is empty because of it.
    expect(notes).toMatch(/Nothing has been posted to the ledger since \d+ \w+ \d{4}/);
    expect(notes).toMatch(/months\b[^.]*nil because the ledger has not moved/);
  });

  it('says nothing about the ledger on a company whose ledger is current', () => {
    // CONDITIONAL AND DERIVED. The demo pack's cover is untouched by this —
    // a cover that carried the sentence where it does not apply would be a
    // caveat about nothing on the first page a director reads.
    expect(caveatOf(liveDemoShortPanelsInput)).toBeNull();
    const notes = coverNotes(buildBoardPackPages(liveDemoShortPanelsInput));
    expect(notes.some((n) => /posted to the ledger since/.test(n)),
      `the demo cover carries a ledger caveat it has no basis for: ${notes.join(' / ')}`).toBe(false);
    // And it still carries the two facts it always did.
    expect(notes.some((n) => n.startsWith('Preparation —'))).toBe(true);
    expect(notes.some((n) => n.startsWith('Period covered —'))).toBe(true);
  });

  it('keeps the cover to one sheet on both companies', () => {
    // The cover is the lowest-density sheet in the pack and this is the first
    // thing ever added to it conditionally; asserting the sentence without
    // asserting the sheet is how a fix for a reading defect becomes a layout
    // one.
    for (const input of [brightsphereLiveInput, liveDemoShortPanelsInput]) {
      const doc = buildBoardPackPages(input);
      expect(doc.pages).toHaveLength(12);
      expect(doc.numberConvention.scale).toBe(PACK_SCALE);
    }
  });
});
