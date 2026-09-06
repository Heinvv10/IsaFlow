/**
 * How a pack prints a period, in one place.
 *
 * It lived in `boardPackDocument.ts`, which fetches — and `boardPackPages.ts`
 * now needs it too, to head the comparative column. The composer importing the
 * fetcher would close a cycle and drag the database into a synchronous
 * function, so the two lines both callers need live here instead. Nothing
 * changed in the move; `boardPackDocument.ts` re-exports both names.
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * '2026-03-01' -> '1 March 2026', from the ISO STRING PARTS.
 *
 * No `Date` is constructed. This host is UTC+2 and the repo has a live
 * UTC-rollback defect class: `new Date('2026-03-01')` is 28 February locally,
 * which would print a board pack covering a period it does not cover.
 */
export function formatPackDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  const monthName = MONTH_NAMES[Number(month) - 1];
  // An unparseable date is echoed rather than guessed at. The route validates
  // `from`/`to` against an ISO pattern before this is reached, so this branch
  // is unreachable from the API — it exists so a bad direct call prints the
  // string it was given instead of 'NaN undefined NaN'.
  if (monthName === undefined || day === undefined || year === undefined) return iso;
  return `${Number(day)} ${monthName} ${year}`;
}

export function formatPackPeriod(from: string, to: string): string {
  return `${formatPackDate(from)} to ${formatPackDate(to)}`;
}
