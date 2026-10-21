/**
 * Read a money amount the way South African ledgers export it.
 *
 * Handles `1234.56`, `1,234.56`, `1 234,56`, `1234,56`, `R1,234.00`,
 * `R 1 234,56`, `(1 234.00)` (negative), `1234.00 Cr` (negative), `1234 Dr`,
 * `-1234`, and non-breaking / narrow no-break spaces as thousands separators.
 *
 * Empty or missing is 0 — a blank cell means "nothing". Anything else it cannot
 * read is NaN, never 0: the caller must report that row, because importing a
 * garbage cell as zero silently changes a customer's books.
 *
 * Pure, no dependencies — safe on the client and the server.
 */

const SPACES = /[\s   ]/g;

/** Which character is the decimal separator, given the digits-and-separators body. */
function normaliseSeparators(body: string): string | null {
  const commas = (body.match(/,/g) ?? []).length;
  const dots = (body.match(/\./g) ?? []).length;
  if (commas > 0 && dots > 0) {
    // Both present: the LAST one is the decimal separator, the other groups thousands.
    const decimal = body.lastIndexOf(',') > body.lastIndexOf('.') ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    if ((body.match(new RegExp(`\\${decimal}`, 'g')) ?? []).length !== 1) return null;
    if (body.indexOf(thousands) > body.indexOf(decimal)) return null;
    return body.split(thousands).join('').replace(decimal, '.');
  }
  if (commas > 0) {
    if (commas > 1) return body.split(',').join('');
    // One comma: decimal unless exactly three digits follow it (`1,234` groups thousands).
    const after = body.slice(body.indexOf(',') + 1);
    return after.length === 3 ? body.replace(',', '') : body.replace(',', '.');
  }
  if (dots > 1) return body.split('.').join('');
  return body;
}

export function parseAmount(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === 'number') return input;

  let s = input.replace(SPACES, ' ').trim();
  if (s === '') return 0;

  let negative = false;

  // Trailing Cr / Dr marker (Sage / Pastel trial balances).
  const marker = /\s*(cr|dr)$/i.exec(s);
  if (marker) {
    if (marker[1]!.toLowerCase() === 'cr') negative = true;
    s = s.slice(0, marker.index).trim();
  }

  // Accounting parentheses.
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = !negative;
    s = s.slice(1, -1).trim();
  }

  // A sign before or after the currency symbol: "-R 100", "R-100".
  const signAndCurrency = /^(-?)\s*(?:ZAR|R)?\s*(-?)/i.exec(s);
  if (signAndCurrency) {
    const signs = (signAndCurrency[1] ? 1 : 0) + (signAndCurrency[2] ? 1 : 0);
    if (signs > 1) return Number.NaN;
    if (signs === 1) negative = !negative;
    s = s.slice(signAndCurrency[0].length).trim();
  }

  // A trailing minus ("1234-") some exports use.
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }

  // What remains may only be digits, separators and grouping spaces.
  if (!/^[\d.,][\d., ]*$/.test(s)) return Number.NaN;
  // Spaces may only group digits, never sit next to a separator.
  if (/ [.,]|[.,] /.test(s)) return Number.NaN;
  const body = normaliseSeparators(s.replace(/ /g, ''));
  if (body === null || !/^(\d+(\.\d+)?|\.\d+)$/.test(body)) return Number.NaN;

  const n = Number(body);
  if (!Number.isFinite(n)) return Number.NaN;
  return negative ? -n : n;
}
