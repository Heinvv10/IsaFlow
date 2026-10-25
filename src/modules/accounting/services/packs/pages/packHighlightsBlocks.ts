/**
 * Page 3's blocks — the highlight tiles, the per-tile commentary, the
 * "Reading these tiles" notes and the sparkline footnote. Split out of
 * `packPageBlocks.ts` for the 300-line cap; that file re-exports
 * `buildHighlightsBlocks`, so every caller still imports it there.
 */
import { tileCaption } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { disclose, note } from './packBlockBuilders';
import { inWords } from './packInWords';
import { formatDays, formatStatementFigure, formatPctLevel, inProse, type MoneyScale } from '@/lib/format/money';
import { ROUNDING_COMPONENTS_NOTE } from './packBasis';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type {
  PackComparativePeriod,
  PackFootnote,
  PackKpiTile,
  PackPageBlock,
} from './packPageModel';

/** Page 3's one footnote — spec §4.A page 3's multi-year note under each
 *  tile. Referenced by `PackKpiTile.trendFootnote`, which the tile model
 *  leaves null because the PAGE owns its footnote numbering. */
const SPARKLINE_FOOTNOTE = 1;

/**
 * THE LINES THAT COVER LESS OF THE WINDOW THAN THE ONES BESIDE THEM.
 *
 * Page 3's sparklines are drawn to one width, side by side. Gross margin and
 * debtor days have no meaningful figure in a month with no revenue, so those
 * months are dropped rather than plotted as a false zero — on the live demo
 * company that is nine of twelve, three points against the other lines'
 * twelve, at the same width and with nothing on the sheet saying so. A
 * reader compares the shapes, which is the only thing a sparkline is for.
 *
 * Grouped by the window they actually cover rather than listed one by one:
 * the two short lines are short for the same reason and by the same amount,
 * and one clause per tile is three lines of 9.5pt on a sheet that has none
 * spare. Empty where every line covers the whole window, which is the usual
 * case and must cost the sheet nothing.
 */
function shortWindowClause(tiles: PackKpiTile[]): string {
  const short = tiles.filter((t) => t.sparklineWindow !== null && t.sparklineWindow.plotted < t.sparklineWindow.of);
  if (short.length === 0) return '';
  const groups = new Map<string, string[]>();
  for (const tile of short) {
    const window = tile.sparklineWindow!;
    const key = `${window.plotted} of the window's ${window.of} months`;
    groups.set(key, [...(groups.get(key) ?? []), tile.label]);
  }
  const clauses = [...groups].map(([window, labels]) => `${inWords(labels)} plot ${window}`);
  return ` ${inWords(clauses)}: a month with no meaningful figure is dropped rather than drawn as zero, `
    + 'so lines of the same width do not all cover the same months.';
}

/**
 * WHICH LINES ARE DRAWN TO ONE MEASURE, AND WHICH ARE NOT.
 *
 * Page 10 already states this rule about its own panels — "Net profit and Cash
 * share one y-scale, so neither of them can look like it moved more than it
 * did" — and page 3 drew every line to the full height of its own tile while
 * saying nothing. The picture is fixed in `packHighlights`; this is the half
 * of the fix a reader can check. Without it the sheet has a shared scale whose
 * domain is nowhere on the page, which is the same disclosure failure in the
 * other direction.
 *
 * Read off `sparklineScale`, which is what the tile was DRAWN with, so the
 * sentence and the picture cannot drift apart. Empty when no money line is
 * drawn — there is then no shared scale to describe.
 */
/**
 * The ends of a tile's OWN axis, in the unit that axis was drawn in.
 *
 * The unit travels on `sparklineScale` rather than being read off the label,
 * and the formatters are the pack's own — the same `formatPctLevel` and
 * `formatDays` page 10's panels print their ends with, so the two sheets
 * cannot state one measure's range two ways.
 */
function ownRange(tile: PackKpiTile, scale: MoneyScale): string {
  const domain = tile.sparklineScale!;
  const print = (value: number): string => (domain.unit === 'percentage'
    ? formatPctLevel(value)
    : domain.unit === 'days' ? formatDays(value) : inProse(formatStatementFigure(value, { scale })));
  return `${print(domain.min)} to ${print(domain.max)}`;
}

function sharedScaleClause(tiles: PackKpiTile[], scale: MoneyScale): string {
  const shared = tiles.filter((t) => t.sparklineScale?.shared === true);
  const own = tiles.filter((t) => t.sparklineScale !== null && !t.sparklineScale.shared);
  if (shared.length === 0) return '';
  const domain = shared[0]!.sparklineScale!;
  const range = `${inProse(formatStatementFigure(domain.min, { scale }))} to `
    + `${inProse(formatStatementFigure(domain.max, { scale }))}`;
  // AND A LINE THAT CANNOT JOIN THAT DOMAIN STATES ITS OWN.
  //
  // It said only that gross margin and debtor days "are in other units, each
  // drawn on its own" — no range, neither end, nowhere on the sheet. Measured
  // off the demo render, the gross-margin sparkline travels 65.5pt and debtor
  // days 66.5pt beside a revenue line travelling 0.8pt, so a reader could not
  // tell off page 3 whether gross margin moved five points or 6 462. The pack
  // knows the convention — page 10 prints both ends of these same two
  // measures — and this was the one place its own "state the axis" discipline
  // lapsed. Brightsphere never failed it, because all three of its lines are
  // money and share the stated domain.
  const rest = own.length === 0
    ? ''
    : ` ${inWords(own.map((t) => `${t.label} on ${ownRange(t, scale)}`))} `
      + `${own.length === 1 ? 'is' : 'are'} in other units, each drawn on its own.`;
  // "from": a range opening on a bracketed figure read as a list marker.
  return ` ${inWords(shared.map((t) => t.label))} share one y-scale, from ${range}, so none of them `
    + `can look like it moved more than it did.${rest}`;
}

/** Page 3 — the whole period in one page. Spec §4.A: eight tiles, each with
 *  its delta and the basis that delta is measured against. */
export function buildHighlightsBlocks(
  tiles: PackKpiTile[],
  scale: MoneyScale,
  currency: string,
  /** The comparative period the pack states on its basis page, or null where
   *  there is none. The page says which of those two it is, ONCE, and every
   *  tile caption is consistent with it — see `PackKpiDeltaAbsence`. */
  comparative: PackComparativePeriod | null,
  /** The stub at the end of the monthly series, or null where the period ends
   *  on a whole month. Page 3's tiles cover the WHOLE period, whose last month
   *  is this one — see the note below. */
  partial: PackTrendPoint | null,
): { blocks: PackPageBlock[]; footnotes: PackFootnote[] } {
  const highlightTiles = tiles.map((tile) =>
    tile.sparklineSvg === null ? tile : { ...tile, trendFootnote: SPARKLINE_FOOTNOTE },
  );
  const sparklineCount = highlightTiles.filter((t) => t.sparklineSvg !== null).length;
  return {
    blocks: [
      { kind: 'kpiTiles', tiles: highlightTiles },
      // One derived line PER TILE, not a restatement of the page title — a
      // commentary block echoing the heading pads the page's density with
      // repetition, which is the opposite of what spec §5.7 asks for.
      disclose('Commentary', highlightTiles.map((tile) => note(tile.label, tileCaption(tile)))),
      disclose('Reading these tiles', [
        // ONE TRUTH ABOUT THE COMPARATIVE, AND IT IS THE DOCUMENT'S OWN.
        //
        // This note said "no comparative period to measure against" while the
        // statement pages printed a prior column and the basis page named the
        // comparative's dates — because a tile with no movement and a pack
        // with no comparative period had been collapsed into one null. Both
        // halves now read the SAME `comparativePeriod` the basis page prints,
        // so the pack cannot say one thing on sheet 3 and another on sheet 12.
        // AND THE ABSENCES, IN THE SAME NOTE. These were two notes, and the
        // second — "Absent comparatives" — spent a heading and a line saying
        // where the reasons are and that a movement is never drawn from zero.
        // Both halves are about the comparative, so both belong to the note
        // that names it, and the heading the merge saves is what pays for the
        // scale sentence in footnote 1. Sheet 3 composes at 99.7% of its box
        // on Brightsphere's live figures: a new statement here has to displace
        // an old one or the sheet prints an apology for its layout instead.
        note('Comparison basis', comparative === null
          ? 'This pack has no comparative period, so no tile shows a movement and none is shown as a move from zero.'
          : `Each movement is measured against ${comparative.label} — the comparative period the basis page states, and the prior column the statement pages print. `
            + 'A movement is never shown as a move from zero; a tile with none says why in its line of the Commentary above.'),
        // SHORTENED, AND WHAT WENT WAS THE RESTATEMENT. It read "— the
        // comparative period carries no value for that measure, or its prior
        // figure is not a positive base —", which is the Commentary block
        // three centimetres above this one, verbatim: those two sentences ARE
        // the captions `tileCaption` writes. The fact this note exists to
        // disclose is that a blank movement is explained rather than unknown,
        // and that a movement is never drawn from zero; both survive. It cost
        // the sheet one line of 9.5pt, which is what sheet 3 was over by.
        // AND IT NAMES THE BLOCK THE REASON IS ACTUALLY IN. It read "in its
        // own caption above" — a tile has no caption; the reasons are the
        // Commentary block's lines, one per tile, three centimetres up the
        // sheet. A reader who looks where a note sends them and finds nothing
        // stops trusting the note.

        // AND THAT THE PERIOD STOPS PART-WAY THROUGH ITS LAST MONTH.
        //
        // Page 3 was the only substantive sheet in the pack with no
        // part-month statement, and it is the sheet a director reads first
        // and the one most often forwarded on its own. Every tile on it — the
        // two margins, net profit, working capital, debtor days — is measured
        // over a period whose final month is a stub, and pages 5, 8, 10 and
        // 12 each say so about their own figures while this page said
        // nothing.
        //
        // A NOTE, NOT A FOOTNOTE. It is about every tile on the sheet rather
        // than about one of them, and page 3 already carries one anchored
        // footnote; a second, unanchored, superscript beside it is the orphan
        // the tenth gate called conspicuous.
        //
        // AND IT IS ONE LINE. The first draft ran to two and Brightsphere's
        // sheet 3, which composes at 98.7% of its box, paid for it by dropping
        // the Scale note and printing "2 explanatory notes are not printed" —
        // buying a new statement with an old one, which is what every round on
        // this branch has been caught doing.
        ...(partial === null ? [] : [note('Part month',
          `Every tile covers the whole period, whose last month — ${partial.label} — `
          + `is ${partial.daysCovered} of its ${partial.daysInMonth} days.`)]),
        // THE COMPONENTS HALF, like the statement footnotes — see
        // `ROUNDING_FOOTNOTES`. The ratio clause matters most on this sheet,
        // whose headline tile is the gross margin a reader cannot reproduce
        // from the figures beside it, and Brightsphere's sheet 3 composes at
        // 98.7% of its box: carried here it drops the part-month note this
        // page states two lines above. Page 12 carries both halves.
        note('Scale', `Figures are in ${scale} (${currency}). ${ROUNDING_COMPONENTS_NOTE}`),
      ]),
    ],
    // AND THE SPARKLINE IS A DIFFERENT WINDOW FROM THE TILE IT SITS IN.
    // The figure is the whole reporting period; the line beside it is a month
    // at a time, which is the same month-versus-period divergence the trends
    // page carries its own note about — see `trendWindowNote`.
    //
    // AND THE LINES ARE NOT ALL THE SAME WINDOW AS EACH OTHER, which is the
    // half this note used to leave out: `shortWindowClause`. It is paid for
    // out of this note's own restatement — "and show none rather than a line
    // drawn from a single point" said again what the clause before it says,
    // and sheet 3 composes at 98.7% of its box on Brightsphere, so a new
    // sentence has to displace an old one or the sheet prints an apology for
    // its layout instead.
    footnotes: [{
      number: SPARKLINE_FOOTNOTE,
      // "THE TREND'S WHOLE MONTHS": the sparklines draw whole months only
      // (`wholeMonthsOf`), so a pack run to 2 October ends them in September
      // while every tile's figure runs to the 2nd. The same length as the
      // "monthly trend series" it replaces — this sheet fits within a line
      // on the live demo, and the Part month note above names the stub.
      text: "Each tile's figure covers the WHOLE reporting period; the sparkline beside it runs over the trend's "
        + `whole months, a different window. ${sparklineCount} of ${highlightTiles.length} tiles carry one; the rest `
        + `have no monthly series behind them.${shortWindowClause(highlightTiles)}`
        + sharedScaleClause(highlightTiles, scale),
    }],
  };
}
