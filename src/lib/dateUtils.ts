/**
 * Normalize a date value to 'YYYY-MM-DD'. Accepts Date objects, ISO strings,
 * and JavaScript Date.toString() representations. Returns null for null,
 * undefined, or un-parseable input.
 *
 * Uses UTC — appropriate for storage/wire formats but NOT for "today as the
 * user sees it" inputs. For default values on user-facing date pickers, use
 * `localISODate` instead — `toISODate(new Date())` rolls back a day for any
 * user east of UTC after their local midnight.
 */
export function toISODate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0] ?? null;
}

/**
 * Format a Date as 'YYYY-MM-DD' using LOCAL year/month/day. Use this for any
 * default value rendered into an HTML `<input type="date">` so the visible
 * date matches the user's local calendar — `new Date().toISOString().slice(0,10)`
 * silently rolls back a day in any TZ east of UTC after local midnight.
 *
 * Defaults to "today" when no Date is passed.
 */
export function localISODate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * A real LOCAL calendar date from a strict 'YYYY-MM-DD', or null when malformed or not a real date
 * (2026-02-30). The safe way to hand an ISO value to a display formatter: `new Date('2026-10-01')` is UTC
 * midnight and shows the previous day west of UTC.
 */
export function localDateFromISO(iso: string): Date | null {
  try {
    const [y, m, d] = parseISOParts(iso);
    return new Date(y, m - 1, d);
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/** First day of `d`'s LOCAL month as 'YYYY-MM-DD'. */
export function monthStartISO(d: Date = new Date()): string {
  return localISODate(new Date(d.getFullYear(), d.getMonth(), 1));
}

/** Last day of `d`'s LOCAL month as 'YYYY-MM-DD'. */
export function monthEndISO(d: Date = new Date()): string {
  return localISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/**
 * The whole LOCAL calendar month before `d`, e.g. 30 Sep 2026 gives
 * 2026-08-01..2026-08-31. Default period for month-end reports (VAT201 etc.).
 */
export function prevMonthRange(d: Date = new Date()): { start: string; end: string } {
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return { start: monthStartISO(prev), end: monthEndISO(prev) };
}

/** Split a strict 'YYYY-MM-DD' into numbers; RangeError if malformed or not a real date. */
function parseISOParts(iso: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const parts = m ? ([Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number]) : null;
  if (parts && parts[0] < 1000) throw new RangeError(`Unsupported year (before 1000) in date: ${iso}`);
  if (!parts || localISODate(new Date(parts[0], parts[1] - 1, parts[2])) !== iso) {
    throw new RangeError(`Invalid YYYY-MM-DD date: ${iso}`);
  }
  return parts;
}

/** 'YYYY-MM-DD' plus `n` calendar days (negative allowed). Pure calendar arithmetic. Throws RangeError on bad input. */
export function addDaysISO(iso: string, n: number): string {
  parseISOParts(iso);
  const dt = new Date(`${iso}T00:00:00`);
  dt.setDate(dt.getDate() + n);
  return localISODate(dt);
}

/**
 * 'YYYY-MM-DD' shifted by whole years, clamping the day to the target month
 * (2028-02-29 minus 1 year is 2027-02-28, not 2027-03-01). Throws RangeError on bad input.
 */
export function shiftYearISO(iso: string, years: number): string {
  const [y, m, d] = parseISOParts(iso);
  if (y + years < 1000) throw new RangeError(`Unsupported year (before 1000) shifting ${iso} by ${years} years`);
  const last = new Date(y + years, m, 0).getDate();
  return localISODate(new Date(y + years, m - 1, Math.min(d, last)));
}
