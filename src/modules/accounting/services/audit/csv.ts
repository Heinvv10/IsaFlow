/**
 * CSV for the audit pack. Every cell is quoted, and a cell a spreadsheet would
 * read as a formula — one starting with = + - @, a tab or a carriage return —
 * is prefixed with an apostrophe, so a description like `=HYPERLINK(...)`
 * typed into a journal is shown as text, never run, when an auditor opens the
 * file. A plain number (a negative amount) is left as it is.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function neutraliseCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => `"${neutraliseCell(v).replace(/"/g, '""')}"`;
  return [header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';
}
