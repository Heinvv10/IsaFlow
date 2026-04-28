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
