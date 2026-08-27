/**
 * Bank CSV Parser — Shared Utilities
 * Low-level CSV parsing helpers shared by all bank-specific parsers.
 */

/**
 * Parse a CSV string into lines, handling quoted fields.
 */
export function parseCsvLines(csv: string): string[][] {
  if (!csv || csv.trim() === '') return [];

  // Strip a UTF-8 BOM and normalise CRLF/CR — a stray \r otherwise rides along
  // on the last field of every row and defeats blank-row detection.
  const lines = csv.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split('\n');
  return lines.map(line => {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current.trim());
    return fields;
  });
}

/**
 * Parse amount string, handling thousand separators and negative values.
 *
 * Two conventions appear in SA bank exports and they disagree about the comma:
 *   1,234.56  — comma groups thousands (US/UK style)
 *   1 234,56  — space groups thousands, comma is the DECIMAL point (SA style)
 * Blindly stripping commas turned "1 234,56" into 123456 — a 100x overstatement
 * on every ABSA row that used the SA convention. Treat the comma as a decimal
 * point only when there is no dot and it is followed by exactly two digits.
 *
 * That heuristic is a deliberate tradeoff, not a parse: "1,00" is read as 1.00
 * rather than 100, because SA statement exports always carry cents. A file that
 * wrote whole rands as "1,00" meaning one hundred would be misread — no SA bank
 * export here does, and no rule can tell the two apart from the string alone.
 *
 * NOT handled, both returning null (the caller then rejects the row with an
 * "Invalid amount" parse error rather than guessing):
 *   "R 1,234.56"  — currency-prefixed
 *   "(123.45)"    — accounting-style negative in parentheses
 * Neither has turned up in an SA CSV export yet. Add them deliberately, with a
 * test, if one does.
 */
export function parseAmount(value: string): number | null {
  if (!value || value.trim() === '') return null;

  let cleaned = value.trim().replace(/^["']|["']$/g, '').trim();
  const decimalComma = !cleaned.includes('.') && /,\d{2}$/.test(cleaned);

  cleaned = decimalComma
    ? cleaned.replace(/[\s\u00A0]/g, '').replace(',', '.')
    : cleaned.replace(/[,\s\u00A0]/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Convert a date string to YYYY-MM-DD without knowing the layout up front.
 * Accepts YYYY/MM/DD, YYYY-MM-DD, DD/MM/YYYY and DD-MM-YYYY: the four-digit
 * component decides which end the year sits on. Returns null when neither
 * component is a four-digit year, so callers with a known layout keep using
 * `normalizeDate`.
 *
 * A trailing four-digit year is assumed to be DD/MM/YYYY, never MM/DD/YYYY:
 * SA bank exports are day-first, and "03/04/2026" is 3 April, not 4 March.
 * Nothing in the string distinguishes the two below the 13th of the month, so
 * this is an assumption about the source, not a detection.
 */
export function normalizeDateFlexible(dateStr: string): string | null {
  const cleaned = dateStr.trim().replace(/^["']|["']$/g, '').trim();
  const parts = cleaned.split(/[/-]/);
  if (parts.length !== 3) return null;

  if (parts[0]!.length === 4) return normalizeDate(cleaned, cleaned.includes('/') ? 'yyyy/mm/dd' : 'yyyy-mm-dd');
  if (parts[2]!.length === 4) {
    return normalizeDate(cleaned.replace(/-/g, '/'), 'dd/mm/yyyy');
  }
  return null;
}

/**
 * Convert date string to YYYY-MM-DD format.
 */
export function normalizeDate(
  dateStr: string,
  format: 'yyyy/mm/dd' | 'dd/mm/yyyy' | 'yyyy-mm-dd',
): string | null {
  const cleaned = dateStr.trim().replace(/^["']|["']$/g, '').trim();
  if (!cleaned) return null;

  let year: string, month: string, day: string;

  if (format === 'yyyy/mm/dd') {
    const parts = cleaned.split('/');
    if (parts.length !== 3) return null;
    year = parts[0]!; month = parts[1]!; day = parts[2]!;
  } else if (format === 'dd/mm/yyyy') {
    const parts = cleaned.split('/');
    if (parts.length !== 3) return null;
    day = parts[0]!; month = parts[1]!; year = parts[2]!;
  } else if (format === 'yyyy-mm-dd') {
    const parts = cleaned.split('-');
    if (parts.length !== 3) return null;
    year = parts[0]!; month = parts[1]!; day = parts[2]!;
  } else {
    return null;
  }

  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
