/**
 * Read a date from an imported file and return it as ISO `YYYY-MM-DD`, or null.
 *
 * South African convention: DAY FIRST, always. `03/04/2026` is 3 April 2026,
 * never 4 March — and a value that only makes sense month-first (`12/13/2026`)
 * is refused rather than swapped, because silently guessing the order is how a
 * take-on lands every invoice in the wrong month.
 *
 * Accepts `YYYY-MM-DD` (optionally with a time), `YYYY/MM/DD`, `DD/MM/YYYY`,
 * `DD-MM-YYYY`, `DD.MM.YYYY`, `D/M/YYYY`, two-digit years (20YY), `DD MMM YYYY`
 * / `D-MMM-YYYY` / `3 April 2026`, and Excel serial day numbers.
 *
 * Pure, no dependencies — safe on the client and the server.
 */

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9,
  october: 10, november: 11, december: 12,
};

/** Excel's day 0 is 1899-12-30 once its fictitious 29 Feb 1900 is accounted for. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO string when (y, m, d) is a real calendar day, else null. */
function isoIfReal(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function fromExcelSerial(serial: number): string | null {
  // 5-digit serials cover 1927-2173; anything smaller is more likely a year or a code.
  if (!Number.isFinite(serial) || serial < 10_000 || serial >= 100_000) return null;
  const dt = new Date(EXCEL_EPOCH_MS + Math.floor(serial) * DAY_MS);
  return isoIfReal(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function fullYear(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

export function parseImportDate(input: string | number | Date | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) return null;
    return isoIfReal(input.getUTCFullYear(), input.getUTCMonth() + 1, input.getUTCDate());
  }
  if (typeof input === 'number') return fromExcelSerial(input);

  const s = input.trim();
  if (s === '') return null;

  if (/^\d{5}(\.\d+)?$/.test(s)) return fromExcelSerial(Number(s));

  // Year first: YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD, optionally followed by a time.
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return isoIfReal(Number(m[1]), Number(m[2]), Number(m[3]));

  // Day first: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, D/M/YY, optionally followed by a time.
  m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})(?:\s.*)?$/.exec(s);
  if (m) return isoIfReal(fullYear(m[4]!), Number(m[3]), Number(m[1]));

  // Day, month name, year: 03 Apr 2026, 3-April-2026, 03.Sept.2026.
  m = /^(\d{1,2})[\s\-./]+([A-Za-z]+)\.?[\s\-./,]+(\d{4}|\d{2})$/.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    if (!month) return null;
    return isoIfReal(fullYear(m[3]!), month, Number(m[1]));
  }

  return null;
}
