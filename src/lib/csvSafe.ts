/**
 * CSV injection neutralization (CWE-1236).
 * Spreadsheet apps execute cells whose text starts with =, +, -, @, tab, or CR
 * as formulas. Prefixing with a single quote forces text interpretation.
 * Pure + browser-safe — no runtime dependencies.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Prefix a leading formula trigger with a single quote so spreadsheets treat
 * the cell as text, not a formula.
 */
export function neutralizeCsvCell(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}
