/**
 * CSV utility helpers — shared across all export endpoints.
 *
 * All functions sanitize formula-injection prefixes (OWASP CWE-1236) by
 * prepending a single-quote when the value starts with =, +, -, @, TAB, or CR.
 * The prefix is applied BEFORE quote-wrapping so it lands inside the cell value.
 */

/** Prevent Excel/Sheets formula execution by prefixing dangerous leading chars. */
function sanitizeFormulaInjection(str: string): string {
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

/**
 * Escape a string value for safe embedding in a CSV cell.
 * Always wraps in double-quotes and escapes internal double-quotes.
 * Accepts string | number | null | undefined — nullish values become empty string.
 */
export function csvCell(value: string | number | null | undefined): string {
  const str = sanitizeFormulaInjection(String(value ?? ''));
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Alias for csvCell — used in report export files that call csvVal().
 * Identical behaviour; provided so existing callers don't need renaming.
 */
export function csvVal(value: string | number | null | undefined): string {
  return csvCell(value);
}

/**
 * Conditional quoting variant used in audit-log and custom-report exports.
 * Only wraps in double-quotes when the value contains commas, quotes, or newlines;
 * otherwise returns the plain sanitized string.
 * Nullish values become empty string.
 */
export function escapeCsv(value: string | number | null | undefined): string {
  if (value == null) return '';
  const raw = sanitizeFormulaInjection(String(value));
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}
