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

/**
 * '2026-09-07T06:22:04.572Z' -> '7 September 2026 at 08:22 SAST'.
 *
 * The basis page printed the raw ISO-8601 for both its timestamps — the
 * extract time and the ledger version — to the millisecond, in UTC, on a
 * document whose every other date is set in words. Millisecond precision is
 * not traceability a director can use, and `Z` is not the clock anyone in the
 * business is on: 06:22Z reads as the early hours to a reader who does not
 * know to add two.
 *
 * SAST, because that is where the company is and where the ledger was read.
 * Named in the string rather than implied, so the anchor is still
 * unambiguous — a reader can convert it, which is what an audit anchor
 * actually needs, and nobody has to know what `Z` means.
 *
 * A value that is not an ISO-8601 timestamp comes back UNTOUCHED, and the
 * test for that is a pattern rather than `new Date(...)`: JavaScript's date
 * parsing is lenient enough to turn `posted-through 2026-08-31` — a real
 * `ledgerVersion` shape — into midnight on the 31st, which would print an
 * invented time on the one page whose purpose is traceability. `ledgerVersion`
 * is `string`, and where none was supplied it carries a sentence saying so
 * (R-P46).
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export function formatPackTimestamp(value: string): string {
  if (!ISO_TIMESTAMP.test(value)) return value;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const day = part('day');
  if (day === '') return value;
  return `${day} ${part('month')} ${part('year')} at ${part('hour')}:${part('minute')} SAST`;
}
