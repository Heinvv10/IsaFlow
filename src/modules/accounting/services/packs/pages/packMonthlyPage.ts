/**
 * PAGE 5 — THE RESULT MONTH BY MONTH, AND HOW TO READ ITS TABLE.
 *
 * Lifted out of `boardPackPages` whole: 130 lines of one sheet's blocks and
 * the twelve notes under them, in a composer that had grown to 995. Nothing
 * changed in the move — the figures the blocks read off the composer's scope
 * are arguments now.
 *
 * The table BUILDERS are `packMonthlyResults.ts`; this is the page they go on.
 */
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { ROUNDING_FOOTNOTES } from './packBasis';
import { commentary, mustDisclose, note } from './packPageBlocks';
import { page, type UnnumberedPage } from './packFrontMatter';
import {
  ebitdaMemoSentence,
  MONTHLY_RESULTS_NAV_LABEL,
  monthlyResultsCaption,
  monthlyResultsTitle,
  trendWindowLabel,
} from './packMonthlyResults';
import { partialMonthClauseFor } from './packPartialMonth';
import type { MoneyScale } from '@/lib/format/money';
import type { PackPageBlock, PackTable } from './packPageModel';

export function buildMonthlyResultsPage(
  monthlyResults: PackTable,
  trend: PackTrendPoint[],
  set: PackFigureSet,
  scale: MoneyScale,
  /** The rounding footnote's number on this sheet — the composer owns page
   *  numbering, so it is passed rather than assumed. */
  ROUNDING_FOOTNOTE: number,
): UnnumberedPage {
// Page 5 — the result month by month. See `packMonthlyResults.ts` for why
// it is no longer the period statement sheet 6 prints again three
// centimetres of paper later.
// THE SERIES BLOCKS ARE WHAT VARIES; the EBITDA memorandum and the caption
// below are the period's and are on the sheet either way, which is also
// what keeps a company with no series above the three-block floor.
const monthlySeriesBlocks: PackPageBlock[] = trend.length === 0
  ? [mustDisclose('No monthly series', [
      note('Why', 'No monthly series covers this period, so the result cannot be shown month by '
        + 'month. Nothing is inferred from the period totals in its place; the income statement '
        + 'overleaf carries them.'),
    ])]
  : [
    { kind: 'table', table: monthlyResults },
    mustDisclose('Reading this table', [
      // WHAT THE BANDS ARE, because two of them are headed by a word the
      // income statement does not use, and a heading set in 7pt caps over a
      // 21mm measure cannot carry the definition itself. Revenue and Other
      // income are the two bands of the income side and are the same two the
      // income statement overleaf prints under those names.
      // SHORTENED BY ONE LINE, AND WHAT WENT WAS A SECOND NAMING OF THE
      // SAME THREE BANDS. It read "Cost of sales, Operating and Other are
      // the three bands every expense of a month falls into: cost of sales,
      // everything else above the operating line, and everything below it"
      // — the three column names, then the same three glossed in order, so
      // "cost of sales" appeared twice in one sentence. Naming each band
      // once with its gloss attached says the same thing in three lines
      // instead of four. Every fact stays: what Revenue and Other income
      // are, what each of the three expense bands contains, and that the
      // row adds across.
      note('The columns', 'Revenue is turnover; Other income is what the income statement '
        + 'reports separately. Expenses fall in three: Cost of sales; Operating, above the '
        + 'operating line; Other, below it. The two income columns less the three expense '
        + 'columns are the month\'s net profit, so each row adds across.',
        // AND THE CLAIM CARRIES THE ROUNDING NOTE'S MARKER, because on the
        // live demo pack it is FALSE on four of the twelve rows: Nov 2025
        // reads 2 − 119 − 17 against a printed (133), and Mar, Jun and Aug
        // are each one out the same way. Three of the six column totals are
        // one out too. The page has always printed the rounding note — it
        // is footnote 1 — and nothing on the sheet pointed at it, so an
        // absolute claim stood unqualified on the table that disproves it.
        // Marking the sentence is the whole fix: the arithmetic is right,
        // the note is right, and the two were never joined.
        ROUNDING_FOOTNOTE),
      // AND WHICH WINDOW THIS IS. The trend runs twelve months to the
      // reporting date and the pack's period is whatever was asked for; the
      // closing row states its own window, and this says why it is not the
      // period total on the next sheet.
      // AND WHICH OF ITS MONTHS IS NOT A WHOLE MONTH. The last row of this
      // table is the month CONTAINING the reporting date, so on a pack run
      // mid-month it is a stub — seven days on the pack the visual gate
      // read — summed into the closing row beside eleven whole months. The
      // row and the closing label carry "(part)"; this says what that
      // means, on the sheet the rows are printed on. Appended to the
      // window note rather than given a note of its own: page 5 has the
      // paper for a clause and not for a block.
      // AND SHORTENED, for the same reason and by the same rule. "The
      // reporting period is stated in the footer of every sheet" is a fact
      // the footer of THIS sheet states; the note's job is to say that this
      // table's window is not that period and where the period's own totals
      // are. Both survive, in three lines rather than four, which is what
      // kept the part-month clause on Brightsphere's sheet 5.
      // "WHICH IS THE SERIES PAGE 10 DRAWS" WAS FALSE ON THE DEMO PACK,
      // and true on Brightsphere — the asymmetry is the whole finding.
      // Two of the demo's six panels, gross margin and debtor days, run
      // Jul 2026 to Sep 2026 (part) and say "over 3 periods" in their own
      // titles, because revenue is nil before July and neither ratio is
      // defined without it. `ratioPanel` drops the months it cannot
      // measure rather than plotting a false zero, which is right — and
      // nothing in the demo pack stated that it does.
      //
      // Brightsphere carries the OMISSION rule under `Panels not drawn`:
      // "A panel is omitted when its figure is not meaningful in every
      // period of the window." Its four drawn panels are all 12 periods,
      // so its copy of this sentence is true. The demo has the other case
      // — a measure meaningful in SOME periods — and had no rule for it.
      // The two behaviours are consistent once both are stated: omit where
      // the measure exists nowhere in the window, shorten where it exists
      // in part of it. Shortening is kept rather than converted to
      // omission, because a gross margin over the three months revenue
      // exists is a real measurement and dropping it removes drawn content
      // to make a sentence true.
      //
      // THE RULE IS STATED HERE AND NOT ON PAGE 10, and that is the paper
      // talking. Page 10 composes at 252.47mm of 255 on `liveDemoRendered`
      // — 2.53mm against a block of six or more — and `fitPageToBox`
      // answers an overflow there by dropping the Scale and Period notes,
      // so the page would buy this rule by apologising for its own layout.
      // This note is the pack's one statement about how page 5's window
      // and page 10's panels relate, it is where the false claim was, and
      // the panel titles already carry the period count a reader meets.
      // "WHICH IS THE SERIES PAGE 10 DRAWS" WAS FALSE ON THE DEMO PACK,
      // and true on Brightsphere — the asymmetry is the whole finding.
      // Two of the demo's six panels, gross margin and debtor days, run
      // Jul 2026 to Sep 2026 (part) and say "over 3 periods" in their own
      // titles, because revenue is nil before July and neither ratio is
      // defined without it. Brightsphere's four drawn panels are all twelve
      // periods, so its copy of this sentence was true, which is how the
      // claim survived fourteen gates.
      //
      // "The window page 10 draws from" is true of both: every panel is
      // taken from this window, and a panel that can only be measured over
      // part of it plots that part. It is FOUR CHARACTERS SHORTER than the
      // claim it replaces, which is the whole reason it is this wording —
      // this note has ten to fourteen characters of slack on
      // `liveDemoRendered` (page 5 composes at 251.93mm of 255 and a line
      // of this narrative costs 4.94), and at fifteen more characters
      // `fitPageToBox` drops a note and the sheet apologises for its own
      // layout. The RULE that makes the shortening legible is a different
      // sentence and could not be bought here at any price; see
      // `shortenedPanelsNote`.
      note('The window', `This table covers ${trendWindowLabel(trend)}, the window page 10 `
        + 'draws from. The income statement overleaf carries the reporting period\'s own '
        + 'totals against the comparative.'
        + (partialMonthClauseFor(trend) === null ? '' : ` ${partialMonthClauseFor(trend)}`)),
    ]),
  ];
const monthlyBlocks: PackPageBlock[] = [
  ...monthlySeriesBlocks,
  // THE PACK'S ONE NON-IFRS MEASURE STAYS ON THIS SHEET — see
  // `ebitdaMemoSentence` for why it is stated rather than tabulated, and
  // why sheet 6 could not take it with the note that has to identify it.
  mustDisclose('The reporting period\'s EBITDA', [
    note('EBITDA', ebitdaMemoSentence(set, scale, trend.length === 0 ? null : trendWindowLabel(trend))),
  ]),
  commentary(monthlyResultsCaption(trend, scale)),
];
const snapshot = page(monthlyResultsTitle(trend, scale), MONTHLY_RESULTS_NAV_LABEL, 'Financials', 'high',
  monthlyBlocks, 'portrait', ROUNDING_FOOTNOTES);

  return snapshot;
}
