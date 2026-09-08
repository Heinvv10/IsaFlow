/**
 * A LEDGER THAT STOPPED MOVING, AND THE NIL MONTHS THE BOARD IS SHOWN
 * BECAUSE OF IT.
 *
 * Brightsphere's page 12 records `Ledger version 29 April 2026 at 12:39
 * SAST` against a reporting period that ends on 7 September, and its pages 5
 * and 10 then show May, June, July, August and September as nil. Both facts
 * are true and each is printed. What was never printed is the sentence
 * joining them: that the trailing months are empty because NOTHING HAS BEEN
 * POSTED SINCE APRIL, not because the company transacted nothing.
 *
 * The two readings are worlds apart to a director. "Five months of no trade"
 * is a business in trouble. "Five months of no bookkeeping" is a control
 * failure, and it also means every figure on the other eleven sheets is
 * stale — which is a reason to defer the decisions page 11 asks for rather
 * than to take them. The pack is scrupulous about naming every other limit on
 * its figure set (`n/m` with a reason, the part-month clause, the comparative
 * length, the rounding caveat); this was the one it left a reader to infer
 * from a timestamp in the twelfth sheet's right-hand column.
 *
 * IT IS ON PAGE 4, NOT PAGE 5 OR PAGE 12.
 *
 * Page 12 already carries the timestamp and carrying the consequence there
 * too would put it on the last sheet a board reads, next to the fact it is
 * about but nowhere near the sheets it explains. Page 5 is where the nil
 * months are tabulated and is the obvious home, and it does not have the
 * paper: its caption composes with 3.07mm of slack on live Brightsphere and a
 * line of that narrative costs 5.29, so this sentence would arrive by
 * dropping the caption that says "Nothing at all is posted in 11 of the 12
 * months shown" — trading the observation for its explanation.
 *
 * Page 4 is the page a board reads first, it is prose by specification
 * (§4.A keeps tabular figures off it), and it is the most under-set sheet in
 * either pack: 80.92mm spare on live Brightsphere, 85.86 on the live demo.
 * A statement about how much of the period the figures actually cover is a
 * statement about how to read every page after it, which is what page 4 is
 * for.
 *
 * IT IS SILENT WHERE THE LEDGER IS CURRENT, and that is most packs. Three
 * conditions, all measured rather than assumed: there is a ledger version at
 * all (`null` is the explicit-unavailable case page 12 already states), it
 * falls before the period end, and at least one month AFTER it carries
 * nothing. The last of those is what stops the note firing on a pack whose
 * ledger was last written to on the 6th for a period ending on the 7th —
 * a day of latency is not a stale ledger, and a month with postings in it
 * after the watermark is proof the watermark is not the reason the series
 * ends where it does.
 */
import { formatPackDate } from './packPeriodLabel';
import { mustDisclose, note } from './packPageBlocks';
import type { PackPageBlock } from './packPageModel';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

/** The heading the note prints under, exported so a test asserts the page
 *  carries THIS block rather than any disclosure that mentions a ledger. */
export const LEDGER_STALE_HEADING = 'How current these figures are';

/** A month with nothing at all posted in it — the same test page 5's caption
 *  applies (`monthlyResultsCaption`), read off the same `PackTrendPoint`, so
 *  the count here and the count there cannot come to differ. */
function isNil(point: PackTrendPoint): boolean {
  return point.revenue === 0 && point.expenses === 0;
}

/**
 * The months of the series that fall wholly after the ledger watermark.
 *
 * Compared on the `YYYY-MM` key against the watermark's own year and month,
 * so a watermark of 29 April excludes April itself: April has postings in it
 * — that is what made it the watermark — and counting it would state that a
 * month the board can see figures for is empty.
 */
function monthsAfter(trend: PackTrendPoint[], ledgerVersion: string): PackTrendPoint[] {
  const watermark = ledgerVersion.slice(0, 7);
  return trend.filter((point) => point.month > watermark);
}

/**
 * Page 4's ledger-currency disclosure, or null where the ledger is current.
 *
 * @param ledgerVersion `getLedgerPostedThrough(...)` as page 12 receives it —
 *   an ISO timestamp, or null where no posted journal was read at all.
 * @param trend The twelve-month series pages 5 and 10 draw. The months this
 *   note counts are ITS months, because they are the ones a reader is looking
 *   at when the question occurs to them.
 * @param periodEnd The reporting date, `YYYY-MM-DD`.
 */
export function ledgerStalenessNote(
  ledgerVersion: string | null,
  trend: PackTrendPoint[],
  periodEnd: string,
): PackPageBlock | null {
  if (ledgerVersion === null) return null;
  const posted = ledgerVersion.slice(0, 10);
  if (posted >= periodEnd) return null;

  const after = monthsAfter(trend, ledgerVersion);
  const nil = after.filter(isNil);
  if (nil.length === 0 || nil.length !== after.length) return null;

  // THE COUNT IS OF THE SERIES' OWN MONTHS, and it is stated as a count
  // rather than as a span in days: page 5 prints those months as rows and
  // page 10 as ticks, so "the 5 months after it" is a thing a reader can
  // point at. The date is formatted through `formatPackDate` — the same
  // function page 12 prints the watermark with — so the two sheets state one
  // date in one form.
  const months = nil.length === 1
    ? `${nil[0]!.label}, the one month after that date, is`
    : `The ${nil.length} months after that date are`;
  return mustDisclose(LEDGER_STALE_HEADING, [
    note('Ledger currency',
      `Nothing has been posted to the ledger since ${formatPackDate(posted)}, before the end of `
      + `the reporting period. ${months} nil on the monthly pages because the ledger has not `
      + 'moved, not because the company transacted nothing: every figure in this pack is the '
      + 'ledger as it stood on that date. The basis of preparation states the ledger version in '
      + 'full.'),
  ]);
}
