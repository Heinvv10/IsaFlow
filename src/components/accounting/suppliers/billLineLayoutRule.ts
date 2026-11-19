/**
 * When the bill lines stack. Under `threshold` (the box cannot hold the columns) the lines become cards; they come
 * back to the table only once the box is `HYSTERESIS` wider, so a width that sits on the threshold, or a scrollbar
 * appearing, cannot swap the layout back and forth. 0 means not measured (no layout): the table stays.
 */
export const HYSTERESIS = 24;

export function nextStacked(stacked: boolean, width: number, threshold: number): boolean {
  if (width <= 0) return stacked;
  if (width < threshold) return true;
  if (width >= threshold + HYSTERESIS) return false;
  return stacked;
}

/**
 * The bill page's two columns (lines | 320px summary), for a form marked `[container-type:inline-size]`. Beside the
 * summary the lines box is the form's content width less 386px (summary, gap, card border and margins, measured), so
 * the summary goes beside the lines only from the width where the box clears BillLineItemsTable's table threshold
 * plus HYSTERESIS: 820 + 24 + 386 = 1230 (1232), and with Dimensions open (`data-dimensions=open`)
 * 1060 + 24 + 386 = 1470 (1472).
 * Narrower, it goes under the lines and they take the full width. It reads the form's width and the Dimensions state,
 * never the table/cards state, so the two cannot drive each other round.
 */
export const BILL_FORM_GRID = 'max-w-screen-2xl mx-auto grid grid-cols-1 gap-6 items-start '
  + '[@container(min-width:1232px)]:grid-cols-[1fr_320px] '
  + '[@container(min-width:1232px)_and_(max-width:1471.98px)]:has-[[data-dimensions=open]]:grid-cols-1';
