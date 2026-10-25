/** Export warnings travel in a response header, so their encoded size is capped. */

const HEADER_BUDGET = 2_000;

/**
 * `warnings` cut so the header they are encoded into stays within a budget (a
 * proxy's header buffer is often 4 KB), with a final "... and N more like these."
 * line counting what was cut, so many warnings cannot break the download.
 */
export function capWarningsForHeader(warnings: readonly string[]): string[] {
  const total = warnings.length;
  const more = (n: number) => `… and ${total - n} more like these.`;
  const fits = (n: number) => encodeURIComponent(JSON.stringify(
    n === total ? warnings : [...warnings.slice(0, n), more(n)])).length <= HEADER_BUDGET;
  let shown = total;
  while (shown > 0 && !fits(shown)) shown -= 1;
  return shown < total ? [...warnings.slice(0, shown), more(shown)] : [...warnings];
}
