/**
 * Normalize a date value to 'YYYY-MM-DD'. Accepts Date objects, ISO strings,
 * and JavaScript Date.toString() representations. Returns null for null,
 * undefined, or un-parseable input.
 */
export function toISODate(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0] ?? null;
}
