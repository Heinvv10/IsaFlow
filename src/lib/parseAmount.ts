/**
 * Read a money amount the way South African ledgers export it.
 *
 * Handles `1234.56`, `1,234.56`, `1 234,56`, `1234,56`, `R1,234.00`,
 * `R 1 234,56`, `(1 234.00)` (negative), `1234.00 Cr` (negative), `1234 Dr`,
 * `-1234`, and non-breaking / narrow no-break spaces as thousands separators.
 * A comma before exactly three digits groups thousands (`1,234`) unless the
 * number before it is 0 (`0,500` is 0.5); a malformed grouping (`1,234,56`)
 * is NaN.
 *
 * Empty or missing is 0 — a blank cell means "nothing". Anything else it cannot
 * read is NaN, never 0: the caller must report that row, because importing a
 * garbage cell as zero silently changes a customer's books.
 *
 * Pure, no dependencies — safe on the client and the server.
 */

const SPACES = /[\s   ]/g;

/**
 * The integer part with its thousands separator removed, or null when the
 * grouping is not one a ledger writes: a first group of 1-3 digits, then
 * groups of exactly three (`1,234,567`; not `1,234,56` or `1,23,456`).
 */
function ungroup(integer: string, separator: string): string | null {
  if (!integer.includes(separator)) return integer;
  const groups = integer.split(separator);
  if (!/^\d{1,3}$/.test(groups[0]!) || groups.slice(1).some(g => !/^\d{3}$/.test(g))) return null;
  return groups.join('');
}

/** Which character is the decimal separator, given the digits-and-separators body. */
function normaliseSeparators(body: string): string | null {
  const commas = (body.match(/,/g) ?? []).length;
  const dots = (body.match(/\./g) ?? []).length;
  if (commas > 0 && dots > 0) {
    // Both present: the LAST one is the decimal separator, the other groups thousands.
    const decimal = body.lastIndexOf(',') > body.lastIndexOf('.') ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    if ((body.match(new RegExp(`\\${decimal}`, 'g')) ?? []).length !== 1) return null;
    const [integer, fraction] = body.split(decimal) as [string, string];
    const whole = ungroup(integer, thousands);
    return whole === null ? null : `${whole}.${fraction}`;
  }
  if (commas > 1) return ungroup(body, ',');
  if (commas === 1) {
    // One comma: it groups thousands only when exactly three digits follow and
    // the part before it could lead a grouping (`1,234`). `0,500` is a half: no
    // grouping writes a leading 0. Otherwise it is the decimal comma (`1,23`).
    const [before, after] = body.split(',') as [string, string];
    const grouping = after.length === 3 && /^[1-9]\d{0,2}$/.test(before);
    return grouping ? before + after : `${before}.${after}`;
  }
  if (dots > 1) return ungroup(body, '.');
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
