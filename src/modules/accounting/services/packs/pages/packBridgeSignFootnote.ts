/**
 * Page 6's bridge footnote — what the profit bridge does with position and
 * with colour, and which lines it left out. Split out of `packPageBlocks.ts`
 * for the 300-line cap; that file re-exports `bridgeSignFootnote`, so every
 * caller still imports it there.
 */
import { OPERATING_PROFIT_BAR } from '@/modules/accounting/services/reports/waterfallDataService';
import { inWords } from './packInWords';
import { formatStatementFigure, type MoneyScale } from '@/lib/format/money';
import type { PackChartSpec, PackFootnote, PackTable } from './packPageModel';

/**
 * WHAT THE BRIDGE IS DOING WITH POSITION AND WHAT IT IS DOING WITH COLOUR —
 * because the page stated one rule and drew by two.
 *
 * Sheet 6 prints operating expenses of `226` in the table and `(226)` on the
 * bar six centimetres below it. Both are right and they are not the same
 * quantity: the table states the line as the ledger carries it, and a bridge
 * bar is a STEP — how much that line moved the running total. A cost of 226
 * moves profit by (226).
 *
 * On Brightsphere it reads as an error rather than as a convention:
 * operating expenses are a net CREDIT of (3 717), so the bar is `3 717` and
 * the table `(3 717)`, and the chart appears to state the opposite sign to
 * the table on the same sheet. Nothing on the page said which was which.
 *
 * AND THE SENTENCE THAT SAID IT WAS HALF THE RULE. It read "the bridge draws
 * each line by its EFFECT on net profit", which is true of where a bar is
 * drawn and false of what colour it is: colour keys off the line's CLASS —
 * income green, cost red, in every pack, whichever way the period ran (see
 * `stepColour`). On Brightsphere that produced a green bar pointing DOWN
 * 5 535 and two red bars pointing UP, under a footnote a reader could only
 * read as promising the opposite. Two reviewers have objected to the palette
 * and the class rule has survived both on the merits — a colour that means
 * one thing on a profitable company and another on a distressed one is not
 * carrying meaning — so what was wrong was the sentence. It now states both
 * rules, and names a bar on the page to check each against.
 *
 * DERIVED FROM A BAR THAT ACTUALLY LOOKS WRONG, not printed as boilerplate.
 * Two things make a bar look wrong, and either one puts this note on the
 * page:
 *
 *   1. its bar POINTS the opposite way to the sign of its table cell (Demo's
 *      cost of sales, Brightsphere's operating expenses). The LABEL agrees
 *      with the table — see `WaterfallStep.labelValue`, which is the fix for
 *      the same figure printing with two signs on one sheet — so what is left
 *      to explain is the direction, and that is what this note explains;
 *   2. its ink and its direction disagree — a green bar that points down, a
 *      red one that points up (Brightsphere's revenue).
 *
 * Null when neither happens, because a pack whose bridge nowhere surprises
 * the reader needs no note, and one that printed it anyway would be
 * explaining a contradiction the reader cannot find.
 */
export function bridgeSignFootnote(
  table: PackTable,
  chart: PackChartSpec,
  scale: MoneyScale,
  number: number,
): { footnotes: PackFootnote[]; anchor: string | null } {
  const bars = chart.waterfallBars ?? [];
  const rows = new Map(table.rows.map((row) => [row.label.toLowerCase(), row.figures.actual?.value ?? null]));

  const movements = bars.filter((bar) => bar.kind !== 'subtotal' && bar.kind !== 'open' && bar.kind !== 'close');
  // The sign divergence first, where there is one: it is the harder of the
  // two to read off the page unaided, because it needs the table AND the
  // chart, and it explains the colour case in passing.
  const diverged = movements.find((bar) => {
    const cell = rows.get(bar.label.toLowerCase());
    if (cell === null || cell === undefined || cell === 0) return false;
    const step = bar.end - bar.start;
    return step !== 0 && Math.sign(step) !== Math.sign(cell);
  });
  const contrary = movements.find((bar) => {
    const step = bar.end - bar.start;
    if (step === 0 || bar.paint === undefined) return false;
    return (bar.paint === 'favourable' && step < 0) || (bar.paint === 'unfavourable' && step > 0);
  });
  const named = diverged ?? contrary;
  // WHAT THE BRIDGE LEFT OUT, which is a statement about the drawing whether
  // or not there is a sign to reconcile — see `PackChartSpec.omittedBars`.
  const omitted = chart.omittedBars ?? [];
  // THREE RULES, THREE SENTENCES. `omittedBars` carries both the nil movement
  // lines and the operating-profit subtotal the walk refused, and "a line
  // with a nil figure for the period is not drawn: Operating Profit" is
  // false of the second — the subtotal is dropped on a disagreement with the
  // row three centimetres above, not on a nil.
  //
  // AND THE THIRD IS THE ONE BAR THE READER CANNOT CHECK AGAINST THE AXIS.
  // A step whose rect would be under a pixel is drawn as a hairline on its
  // running total rather than as nothing (`NIL_STEP_RULE_PX`), so on
  // Brightsphere's page 6 an Other Income of (1) is drawn at forty-odd times
  // its own height while every other bar on the sheet is exact to a tenth of
  // a percent. The mark is right — 0.28mm of ink, and the alternative renders
  // nothing, which the first sentence above reserves for a nil line — and it
  // was undisclosed, one clause away from the rule it most resembles.
  const nilLines = omitted.filter((label) => label !== OPERATING_PROFIT_BAR);
  const floored = chart.flooredBars ?? [];
  const omission = [
    nilLines.length === 0
      ? ''
      : ` A line with a nil figure for the period is not drawn: ${inWords(nilLines)}.`,
    floored.length === 0
      ? ''
      : ` A line too small to draw at this scale is drawn as a hairline, so read its figure from `
        + `the label rather than against the axis: ${inWords(floored)}.`,
    omitted.includes(OPERATING_PROFIT_BAR)
      ? ' The operating profit subtotal is not drawn: this bridge\'s own walk and the figure the '
        + 'table above states do not agree, and the bar would be a second figure for one line.'
      : '',
  ].join('');
  // NO EXEMPLAR, NO SIGN SENTENCE — and therefore no anchor either. The
  // caller reads `anchor` to put the superscript on the row this sentence is
  // about, which is why the label is returned rather than only printed: a
  // footnote naming Cost of sales and marking nothing is the unanchored
  // series this whole round is removing. The omission sentence is not about
  // a row, so it stands on its own where there is nothing to reconcile.
  if (named === undefined) {
    return omission === ''
      ? { footnotes: [], anchor: null }
      : { anchor: null, footnotes: [{ number, required: true as const, text: omission.trim() }] };
  }

  const step = named.end - named.start;
  const klass = named.paint === 'favourable' ? 'an income line' : 'a cost line';
  const ink = named.paint === 'favourable' ? 'green' : 'red';
  const moved = step < 0 ? 'reduces' : 'increases';
  const cell = rows.get(named.label.toLowerCase());
  // The example reconciles the TABLE with the bar where the two diverge, and
  // the DIRECTION with the ink where they do not: a reader given the second
  // sentence for a bar whose table cell agrees with it would be sent to
  // check an agreement.
  const example = diverged !== undefined && cell !== null && cell !== undefined
    ? `${named.label} of ${formatStatementFigure(cell, { scale })} in the table is labelled with that same `
      + `figure on the bridge, drawn ${step < 0 ? 'DOWNWARDS' : 'UPWARDS'} because that is the `
      + `direction it ${moved} profit, and in ${ink}, because it is ${klass}. The label and the `
      + 'position are the same fact read two ways.'
    : `${named.label} is drawn in ${ink}, because it is ${klass}, and points `
      + `${step < 0 ? 'DOWN' : 'UP'}, because that is the direction it moved profit this period.`;

  return { anchor: named.label, footnotes: [{
    number,
    // REQUIRED — see `PackFootnote.required`. This is the only thing on the
    // sheet that reconciles a table cell with the bar drawn from it, and on
    // Brightsphere the fitter took it, leaving a chart that appears to state
    // the opposite sign to the table beside it.
    required: true as const,
    text:
      `The table states each line as the ledger carries it. The bridge below POSITIONS each bar `
      + `by its effect on net profit — up where the line added to it, down where it took away — `
      // THREE INKS, AND THE LIST CLOSED AT TWO. The bridge draws green for
      // income, red for cost and DARK for a total, and this sentence named
      // the first two and stopped — on a chart whose largest marks are the
      // totals. The third was defined on page 12's Colour key, eleven sheets
      // from the picture it explains, so a reader of this footnote was told a
      // complete-looking rule that its own chart breaks twice.
      + `and COLOURS it by what the line is: green for income, red for cost, dark for a total, in `
      + `every pack and whichever way the period ran. ${example}${omission}`,
  }] };
}
