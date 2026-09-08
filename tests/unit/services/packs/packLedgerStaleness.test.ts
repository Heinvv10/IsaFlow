/**
 * FIVE NIL MONTHS, AND THE SENTENCE THAT SAYS WHY THEY ARE NIL.
 *
 * The live client pack records its ledger version on page 12 — 29 April 2026
 * — and then shows May through September as nil on pages 5 and 10. Both facts
 * were printed. The one that was not is that the second is CAUSED by the
 * first: nothing has been posted since April, so the trailing months are
 * empty because the bookkeeping stopped, not because the company did.
 *
 * A director cannot tell those apart from the sheets, and they are opposite
 * conclusions: one is a business with no trade and the other is a control
 * failure that also makes every other figure in the pack four months old.
 *
 * These hold both directions. A pack whose ledger is current must not carry
 * the note, and a pack whose ledger stopped inside the period must not be
 * able to reach a reader without it.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  LEDGER_STALE_HEADING,
  ledgerStalenessNote,
} from '@/modules/accounting/services/packs/pages/packLedgerStaleness';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { brightsphereLiveInput, brightsphereLiveTrend, demoInput } from './fixtures/boardPackInputs';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

const NARRATIVE_PAGE = 'Commentary and actions';

function stalenessBody(input: BoardPackInput): string | null {
  const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === NARRATIVE_PAGE);
  if (page === undefined) throw new Error('the pack has no narrative page');
  for (const block of page.blocks) {
    if (block.kind !== 'disclosure') continue;
    if (block.disclosure.heading !== LEDGER_STALE_HEADING) continue;
    return block.disclosure.notes.map((n) => n.body).join(' ');
  }
  return null;
}

describe('a ledger that stopped moving says so on the page a board reads first', () => {
  it('names the date, the months, and which of the two readings is the right one', () => {
    const body = stalenessBody(brightsphereLiveInput);

    expect(body, 'the pack shows five nil months and never says why').not.toBeNull();
    // The watermark in the pack's own date form — the same one page 12
    // prints it in, so the two sheets state one date.
    expect(body).toContain('29 April 2026');
    // Five: May, June, July, August and September of
    // `brightsphereLiveTrend`. Counted off the series the reader is looking
    // at rather than in days.
    expect(body).toContain('5 months');
    // And the conclusion, which is the whole point of the note.
    expect(body).toMatch(/ledger has not moved/);
    expect(body).toMatch(/not because the company transacted nothing/);
  });

  it('does not make the board hunt for the timestamp on the last sheet', () => {
    // It says the basis page carries the version in full, rather than
    // repeating the timestamp — a pointer to where the audit anchor lives,
    // not a second rendering of it that could come to disagree.
    expect(stalenessBody(brightsphereLiveInput)).toMatch(/basis of preparation/i);
  });

  it('costs its page nothing it cannot spare', () => {
    const page = buildBoardPackPages(brightsphereLiveInput).pages
      .find((p) => p.navLabel === NARRATIVE_PAGE)!;
    expect(page.footnotes.some((f) => f.text.startsWith(OMISSION_MARK)),
      'page 4 apologised for its layout rather than carrying the note').toBe(false);
  });

  it('is absent from a pack whose ledger is current', () => {
    // The live demo company's ledger was last posted to on the reporting date
    // itself, and `demoInput`'s watermark is its period end. Neither pack
    // has anything to disclose.
    expect(stalenessBody(liveDemoRenderedInput)).toBeNull();
    expect(stalenessBody(demoInput)).toBeNull();
  });
});

describe('ledgerStalenessNote refuses the cases it cannot speak to', () => {
  const END = '2026-09-07';

  it('is silent where no posted journal was read at all', () => {
    // Page 12 already states "unavailable" for that pack. A note asserting
    // the ledger stopped on a date the pack does not have is an invention.
    expect(ledgerStalenessNote(null, brightsphereLiveTrend, END)).toBeNull();
  });

  it('is silent on a watermark inside the reporting date', () => {
    expect(ledgerStalenessNote('2026-09-07T15:45:00.000Z', brightsphereLiveTrend, END)).toBeNull();
  });

  it('will not call a ledger stale when it was posted to on the reporting date', () => {
    // The nil-months test below cannot reach this on its own: `getPackTrend`
    // builds twelve months TO the reporting month, so a series never runs
    // past the period end and a current watermark has no months after it to
    // find empty. This passes a series that DOES run past it, which is the
    // shape a caller could hand this function by pairing a trend with the
    // wrong window — and the answer must still be that a ledger posted to on
    // the reporting date is not stale, whatever comes after it.
    const past: PackTrendPoint[] = [
      ...brightsphereLiveTrend,
      { ...brightsphereLiveTrend[0]!, month: '2026-10', label: 'Oct 2026', revenue: 0, expenses: 0 },
      { ...brightsphereLiveTrend[0]!, month: '2026-11', label: 'Nov 2026', revenue: 0, expenses: 0 },
    ];
    expect(ledgerStalenessNote('2026-09-07T15:45:00.000Z', past, END)).toBeNull();
    // And the same series with a watermark that IS before the period end
    // does produce a note, so the assertion above is the guard talking and
    // not the fixture failing some other test.
    expect(ledgerStalenessNote('2026-04-29T10:39:11.480Z', past, END)).not.toBeNull();
  });

  it('is silent where a month AFTER the watermark carries postings', () => {
    // A day of latency is not a stale ledger, and postings after the
    // watermark are proof the watermark is not why the series ends where it
    // does. Without this the note fires on any pack whose last journal
    // predates the reporting date, which is nearly all of them.
    const posted: PackTrendPoint[] = brightsphereLiveTrend.map((point, i) => (
      i === brightsphereLiveTrend.length - 1 ? { ...point, revenue: 1_000 } : point
    ));
    expect(ledgerStalenessNote('2026-04-29T10:39:11.480Z', posted, END)).toBeNull();
  });

  it('does not count the watermark\'s own month as empty', () => {
    // April is where the whole year is posted — that is what made it the
    // watermark. Counting it would tell the board a month it can read
    // figures for is nil.
    const body = ledgerStalenessNote('2026-04-29T10:39:11.480Z', brightsphereLiveTrend, END);
    expect(body?.kind === 'disclosure' ? body.disclosure.notes[0]!.body : '')
      .not.toContain('6 months');
  });
});
