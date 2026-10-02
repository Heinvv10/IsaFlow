/**
 * HOW CURRENT THE FIGURES ARE, AS ONE READING FOR THE TWO PLACES THAT STATE
 * IT.
 *
 * Page 4 carries the full disclosure and the contents page carries a caveat;
 * both are the same fact about the same ledger, and a pack whose sheet 4 says
 * five months are nil while its sheet 2 lists two caveats that do not mention
 * the ledger is a pack disagreeing with itself about what a director is
 * looking at.
 *
 * IT LIVES HERE RATHER THAN BESIDE THE PAGE-4 BLOCK because `packBasis` needs
 * the caveat and `packLedgerStaleness` needs `packPageBlocks` for its
 * disclosure — and `packPageBlocks` reaches `packBasis` again. A cycle that
 * leaves a module-level constant undefined at import time is not a compile
 * error; it is a `SOURCES.map` of undefined at first call.
 */
import { formatPackDate, packDateOf } from './packPeriodLabel';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

/**
 * The months of the series that fall wholly after the ledger watermark.
 *
 * Compared on the `YYYY-MM` key against the watermark's own year and month,
 * so a watermark of 29 April excludes April itself: April has postings in it
 * — that is what made it the watermark — and counting it would state that a
 * month the board can see figures for is empty.
 *
 * THE MONTH IS TAKEN OFF THE SAST DAY, not off the ISO string. Slicing
 * `2026-04-30T22:30:00.000Z` gives April, and that instant is 1 May on the
 * clock the company posts on — so May was counted as wholly after a
 * watermark that was written inside it, and the pack could state that
 * nothing had been posted after 30 April in a month that was written to.
 * See `packDateOf`.
 */
function monthsAfter(trend: PackTrendPoint[], postedDay: string): PackTrendPoint[] {
  const watermark = postedDay.slice(0, 7);
  return trend.filter((point) => point.month > watermark);
}

/** A month with nothing at all posted in it — the same test page 5's caption
 *  applies (`monthlyResultsCaption`), read off the same `PackTrendPoint`, so
 *  the count here and the count there cannot come to differ. */
function isNil(point: PackTrendPoint): boolean {
  return point.revenue === 0 && point.expenses === 0;
}

/**
 * THE SAME FACT, SHORT ENOUGH TO BE A CAVEAT — or null where the ledger is
 * current.
 *
 * The demo pack's period qualification ("the fiscal period it ends in is
 * still open, so these figures can still move") reaches the COVER and the
 * contents page's Caveat 2. Brightsphere's is bigger — nothing has been
 * posted since 29 April, five months before the period end — and it surfaced
 * once, on sheet 4, while its cover and caveats said only that no commentary
 * had been approved and sheet 12 counted "2 caveats". A director reading
 * sheets 1 to 3 formed a view of a period the ledger never covered.
 *
 * One sentence, because a caveat is a line on a page that indexes twelve
 * others; sheet 4 keeps the full statement, and this is what sends a reader
 * to it.
 */
export function ledgerStalenessCaveat(
  ledgerVersion: string | null,
  trend: PackTrendPoint[],
  periodEnd: string,
): string | null {
  const stale = staleMonths(ledgerVersion, trend, periodEnd);
  if (stale === null) return null;
  const { posted, nil } = stale;
  return `Nothing has been posted to the ledger since ${formatPackDate(posted)}, before the end `
    + `of the reporting period, so the ${nil.length === 1 ? 'month' : `${nil.length} months`} `
    + 'after it are nil because the ledger has not moved.';
}

/** The watermark and the wholly-empty months after it, or null where the
 *  ledger reaches the period end or the months after it are not all empty.
 *  ONE reading, so the caveat and page 4's block cannot disagree. */
export function staleMonths(
  ledgerVersion: string | null,
  trend: PackTrendPoint[],
  periodEnd: string,
): { posted: string; nil: PackTrendPoint[] } | null {
  if (ledgerVersion === null) return null;
  // THE WATERMARK'S CALENDAR DAY, IN SAST — the same day page 12's
  // `formatPackTimestamp` prints, rather than the UTC day the ISO string
  // starts with. See `packDateOf` for what the two disagreed about.
  const posted = packDateOf(ledgerVersion);
  if (posted >= periodEnd) return null;
  const after = monthsAfter(trend, posted);
  const nil = after.filter(isNil);
  if (nil.length === 0 || nil.length !== after.length) return null;
  return { posted, nil };
}

