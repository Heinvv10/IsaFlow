/** Reading a chart's printed labels back off the SVG zrender emits. */

/**
 * Every `<text>` in the SVG, as a font size and the y it is centred on.
 *
 * zrender emits the position in a `transform="translate(x y)"` and the size
 * in an inline `style`, so both come off the same element and neither is
 * assumed.
 */
export interface Label { x: number; y: number; size: number; text: string }

export function labels(svg: string): Label[] {
  const out: Label[] = [];
  for (const match of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = match[1] ?? '';
    const position = /transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(attrs);
    const size = /font-size:([\d.]+)px/.exec(attrs);
    if (position === null || size === null) continue;
    out.push({
      x: Number(position[1]),
      y: Number(position[2]),
      size: Number(size[1]),
      text: (match[2] ?? '').replace(/&#39;/g, "'"),
    });
  }
  return out;
}

/**
 * The value-axis ticks: the labels sharing the x the axis draws them at.
 *
 * Picked by the column they occupy rather than by matching their text — the
 * axis formatter is `formatMoney`, so a tick reads `(3 000)` or `–` and a
 * text match would quietly select nothing the day the formatter changes,
 * which is a green test asserting an empty list.
 */
export function yAxisTicks(svg: string): Label[] {
  const all = labels(svg);
  const byColumn = new Map<number, Label[]>();
  for (const label of all) {
    const column = byColumn.get(label.x) ?? [];
    column.push(label);
    byColumn.set(label.x, column);
  }
  const ticks = [...byColumn.values()].reduce((a, b) => (b.length > a.length ? b : a), []);
  return [...ticks].sort((a, b) => a.y - b.y);
}

/** The smallest distance between two neighbouring ticks' centres. */
export function tightestGap(ticks: Label[]): number {
  let tightest = Infinity;
  for (let i = 1; i < ticks.length; i += 1) {
    tightest = Math.min(tightest, ticks[i]!.y - ticks[i - 1]!.y);
  }
  return tightest;
}
