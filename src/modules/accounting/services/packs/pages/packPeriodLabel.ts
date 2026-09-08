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

/**
 * THE CALENDAR DAY AN INSTANT FELL ON, ON THE COMPANY'S OWN CLOCK.
 *
 * `ledgerVersion` is `MAX(je.created_at).toISOString()` — a UTC instant — and
 * the pack states it twice in two shapes: page 12 prints the whole timestamp
 * through `formatPackTimestamp`, which converts to `Africa/Johannesburg`, and
 * pages 2 and 4 name the DAY it fell on. Those two took the day by slicing
 * the ISO string, which is the UTC day: a ledger last written at
 * `2026-04-29T22:30:00.000Z` is 30 April at 00:30 SAST, so page 12 said 30
 * April while page 4 said "nothing has been posted since 29 April" — one
 * fact, two dates, on the anchor every other sheet's traceability rests on.
 * Overnight imports and after-hours close runs land in that two-hour window
 * as a matter of course.
 *
 * SO THE DAY IS DERIVED THROUGH THE SAME FORMATTER PAGE 12 PRINTS, and the
 * two sheets name one day by construction rather than by both being sliced
 * the same way. `en-ZA` with numeric parts, composed here rather than read
 * off a locale pattern, so the order is this function's and not `Intl`'s.
 *
 * A value that is not an ISO-8601 timestamp is sliced, unchanged: a plain
 * `YYYY-MM-DD` has no instant to convert and the "no watermark" sentence
 * carries no date at all. Same refusal `formatPackTimestamp` makes, for the
 * same reason.
 */
export function packDateOf(value: string): string {
  if (!ISO_TIMESTAMP.test(value)) return value.slice(0, 10);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (year === '' || month === '' || day === '') return value.slice(0, 10);
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * WHETHER THE COMPARATIVE IS THE SAME LENGTH AS THE PERIOD IT SITS BESIDE.
 *
 * The fifteenth gate withheld credit for this rather than failing a
 * criterion: 1 January to 7 September 2026 is 250 days and 26 April to 31
 * December 2025 is also 250, which is what makes the prior column and the
 * annualised day counts comparable at all, and the pack said so nowhere. A
 * reader who checks it has the most reassuring fact about the comparison; a
 * reader who does not check it is entitled to be told.
 *
 * It states the MEASUREMENT and not a verdict, so the clause is as true of a
 * pack whose windows differ — which is the case a director needs it for. The
 * day counts are inclusive of both endpoints, counted off the ISO parts
 * through `Date.UTC` rather than `new Date(iso)`: this host is UTC+2 and a
 * local-midnight parse is a day short of the window it is measuring.
 */
function inclusiveDays(start: string, end: string): number | null {
  const utc = (iso: string): number => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  };
  const days = Math.round((utc(end) - utc(start)) / 86_400_000) + 1;
  // A MALFORMED DATE IS NOT A DAY COUNT. `?? 0` covered a missing part and
  // not a non-numeric one: `Number('xx')` is NaN, `Date.UTC` carries it
  // through, and the clause printed "NaN days" on a sheet whose whole claim
  // is that the two windows are comparable. Null here, and the caller says
  // nothing rather than something false.
  return Number.isFinite(days) ? days : null;
}

export function comparativeLengthClause(
  current: { start: string; end: string },
  prior: { start: string; end: string },
): string {
  const days = inclusiveDays(prior.start, prior.end);
  const reporting = inclusiveDays(current.start, current.end);
  // The clause is a whole sentence after an em dash on page 6, 7, 8 and 9's
  // prior-column footnote, so an unmeasurable window must still finish it.
  // The route validates both dates before this is reached; this is what a
  // bad direct call prints instead of "NaN days".
  if (days === null || reporting === null) {
    return 'its length could not be measured from the dates given.';
  }
  return days === reporting
    ? `${days} days, the same length as the reporting period.`
    : `${days} days against the reporting period's ${reporting}.`;
}
