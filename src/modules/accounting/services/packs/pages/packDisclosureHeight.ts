/**
 * How tall a disclosure block is — the page gutter, the measure a note is set
 * across, and the two-column balance the glossary shares. Split out of
 * `packBlockHeights.ts` for the 300-line cap; that file re-exports every
 * export here, so each caller still imports it there.
 */
import { lines, PAGE_WIDTH_MM, wrappedLines, type PageOrientation } from './packTextMetrics';
import type { PackDisclosure } from './packPageModel';

/** `--pack-gutter`. */
export const GUTTER_MM = 8;

/** The measure a disclosure note is set across — the full page in portrait,
 *  one of two columns in landscape. */
function noteMeasureMm(orientation: PageOrientation): number {
  if (orientation === 'portrait') return PAGE_WIDTH_MM.portrait;
  // A landscape column is 126.4mm. It is budgeted at 116: the column-balancer
  // below turns one extra line into half a line of page, and half a line is
  // the difference between the trends page fitting and not.
  return 116;
}

/** `.pack-disclosure` — a 15pt heading, then one 14pt paragraph per note. */
export function disclosureMm(disclosure: PackDisclosure, orientation: PageOrientation): number {
  const heading = lines(wrappedLines(disclosure.heading, 11, PAGE_WIDTH_MM[orientation]), 15);
  const twoColumn = disclosure.columns === 2 && orientation === 'portrait';
  const measure = twoColumn ? (PAGE_WIDTH_MM.portrait - GUTTER_MM) / 2 : noteMeasureMm(orientation);
  // The list variant is set at the glossary's 8.5pt (see `packPrint.css`); a
  // disclosure that is an ARGUMENT keeps the pack's 9.5pt prose size.
  const notePt = twoColumn ? 8.5 : 9.5;
  const noteLines = disclosure.notes.map((n) => wrappedLines(`${n.heading} ${n.body}`, notePt, measure));
  const total = noteLines.reduce((a, b) => a + b, 0);
  if (twoColumn) {
    // Each note is `break-inside: avoid`, so the block is the taller of the
    // two columns under Chromium's own in-order balance — the same model
    // `blockMm` uses for the glossary, and for the same reason.
    //
    // PLUS ONE LINE, WHICH IS THE BALANCER'S OWN SLACK AND NOT A FUDGE.
    // `balancedLines` is the BEST in-order split; Chromium's multicol
    // balancer does not always find it. Measured on the basis page's own
    // block against the real faces: at eight notes and at six it lays the
    // taller column out one line above the best split, and at seven, five,
    // four and three it hits the split exactly. One line is that error, and
    // `packSheetCount.test.ts` re-measures it on every fixture.
    //
    // This used to be paid for by charging `(notes - 1) * 1.5` for the gap
    // between notes, which covered the balancer by accident and cost the
    // block ten millimetres for eight one-line facts. The gap is now zero in
    // `packPrint.css` — a list of label-and-value pairs on a 14pt leading is
    // separated already — and the balancer is paid for on purpose.
    return heading + 1.5 + lines(balancedLines(noteLines) + 1, 12);
  }
  if (orientation === 'portrait') return heading + disclosure.notes.length * 1.5 + lines(total, 14);
  // Landscape sets the notes in two balanced columns (`column-count: 2`) and
  // the block is as tall as the taller one. Chromium balances by LINE across
  // the whole block, so the height is half the lines — floored at two,
  // because a two-line note is the one shape that cannot split (each column
  // would keep a single line, which `widows`/`orphans` refuse). The gaps ride
  // in the taller column, the pessimistic reading of where they land.
  const balanced = Math.max(2, Math.ceil(total / 2));
  return heading + 1.5 + lines(balanced, 14) + Math.max(0, disclosure.notes.length - 1) * 1.5;
}

/**
 * The taller of two balanced columns of unbreakable items, in the items' own
 * units.
 *
 * Chromium balances a `column-count: 2` block by finding the SMALLEST height
 * at which a greedy top-to-bottom fill still fits in two columns; with
 * `break-inside: avoid` on every item, that is exactly the best in-order
 * split. Modelled rather than approximated: a `total / 2` reads short by up
 * to a whole item, and `total / 2 + the tallest item` — the safe fudge — cost
 * page 12 forty millimetres it did not have.
 *
 * @param gap The space BETWEEN two items in the same column, in the items'
 *   own units — `.pack-definition + .pack-definition`'s 2mm, and zero for a
 *   list that has none.
 *
 *   It is charged per COLUMN, not per item, because the item that starts the
 *   second column does not print it: a `margin-top` at the top of a
 *   fragmentainer is truncated, and Chromium truncates this one. Baking it
 *   into every item but the first — which is what the caller used to do —
 *   therefore charges one gap that never reaches paper. Two millimetres,
 *   measured: the live demo company's glossary lays out at 155.7mm under the
 *   print harness against 157.7mm of estimate, and page 12 was 0.67mm over
 *   its box, so those two millimetres were costing the sheet FOUR of its
 *   eight provenance facts.
 */
export function balancedLines(items: number[], gap = 0): number {
  const total = items.reduce((a, b) => a + b, 0);
  let best = Infinity;
  let head = 0;
  for (let i = 0; i < items.length; i += 1) {
    head += items[i]!;
    // Items 0..i in the first column, the rest in the second; each column
    // pays for the gaps BETWEEN its own items and none above its first.
    const first = head + i * gap;
    const second = (total - head) + Math.max(0, items.length - i - 2) * gap;
    best = Math.min(best, Math.max(first, second));
  }
  return best;
}
