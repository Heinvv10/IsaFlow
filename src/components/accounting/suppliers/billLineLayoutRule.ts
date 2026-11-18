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
