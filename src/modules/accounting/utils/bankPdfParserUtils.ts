/**
 * WS-8.2: Bank PDF Parser Shared Utilities
 *
 * Common parsing helpers used by all SA bank PDF parsers.
 * Handles the messy real-world output from pdf-parse: merged words,
 * inconsistent spacing, OCR artefacts.
 */

// Month name lookups — short and long forms
const MONTH_SHORT: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};
const MONTH_LONG: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

/**
 * Parse various date string formats to YYYY-MM-DD.
 *
 * Handles:
 *   DD/MM/YYYY    15/01/2026
 *   DD-MM-YYYY    15-01-2026
 *   DD MMM YYYY   15 Jan 2026
 *   DD Mon YYYY   15 January 2026
 *   YYYY/MM/DD    2026/01/15
 *   YYYY-MM-DD    2026-01-15
 */
export function parseDate(dateStr: string): string | null {
  if (!dateStr || !dateStr.trim()) return null;
  const s = dateStr.trim();

  // YYYY/MM/DD or YYYY-MM-DD
  const isoMatch = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return buildDate(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10));
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return buildDate(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10));
  }

  // DD MMM YYYY or DD Mon YYYY (e.g. "15 Jan 2026" or "15 January 2026")
  const wordDate = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (wordDate) {
    const [, d, mon, y] = wordDate;
    const monthKey = mon!.toLowerCase();
    const monthNum = MONTH_SHORT[monthKey.substring(0, 3)] ?? MONTH_LONG[monthKey] ?? null;
    if (!monthNum) return null;
    return buildDate(parseInt(y!, 10), parseInt(monthNum, 10), parseInt(d!, 10));
  }

  return null;
}

function buildDate(year: number, month: number, day: number): string | null {
  if (
    isNaN(year) || isNaN(month) || isNaN(day) ||
    year < 2000 || year > 2099 ||
    month < 1 || month > 12 ||
    day < 1 || day > 31
  ) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parse an amount string to a signed number.
 *
 * Handles:
 *   "1,234.56"        → 1234.56
 *   "-1,234.56"       → -1234.56
 *   "1 234.56"        → 1234.56
 *   "(1,234.56)"      → -1234.56
 *   "1234.56 Dr"      → -1234.56  (debit)
 *   "1234.56 Cr"      → 1234.56   (credit)
 *   "R 1 234.56"      → 1234.56   (rand prefix)
 */
export function parseAmount(amountStr: string): number | null {
  if (!amountStr || !amountStr.trim()) return null;
  const s = amountStr.trim();

  // Determine sign from suffix Dr/Cr
  let suffix = 1;
  let cleaned = s;
  const drMatch = s.match(/^(.*?)\s*(Dr|DR|debit)$/i);
  const crMatch = s.match(/^(.*?)\s*(Cr|CR|credit)$/i);
  if (drMatch) { suffix = -1; cleaned = drMatch[1]!; }
  else if (crMatch) { suffix = 1; cleaned = crMatch[1]!; }

  // Strip currency prefix (R, ZAR)
  cleaned = cleaned.replace(/^R\s*/i, '').replace(/^ZAR\s*/i, '');

  // Parentheses denote negative: (1,234.56)
  const parenMatch = cleaned.match(/^\(([^)]+)\)$/);
  if (parenMatch) {
    cleaned = parenMatch[1]!;
    suffix = -1;
  }

  // Preserve leading minus
  const isNeg = cleaned.trim().startsWith('-');
  if (isNeg) cleaned = cleaned.trim().substring(1);

  // Remove thousand separators (commas and spaces), keep decimal point
  cleaned = cleaned.replace(/[,\s]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;

  return (isNeg ? -1 : 1) * suffix * num;
}

/**
 * Clean description text: collapse whitespace, remove leading/trailing garbage.
 */
export function cleanDescription(desc: string): string {
  return desc
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-|:]+/, '')
    .replace(/[\s\-|:]+$/, '')
    .trim();
}

/**
 * Extract account number from header text.
 *
 * Looks for patterns like:
 *   "Account Number: 12345678"
 *   "Acc No: 12345678"
 *   "Account No 12345678"
 */
export function extractAccountNumber(text: string): string | null {
  const patterns = [
    /account\s+(?:number|no\.?|num\.?)\s*[:-]?\s*(\d[\d\s-]{4,20})/i,
    /acc(?:ount)?\s*(?:no\.?|num\.?|#)\s*[:-]?\s*(\d[\d\s-]{4,20})/i,
    /\bA\/C\s*[:-]?\s*(\d[\d\s-]{4,20})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/[\s-]/g, '').trim();
    }
  }
  return null;
}

/**
 * Check if a string looks like a transaction date in any supported format.
 */
export function isDateLike(s: string): boolean {
  return (
    /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(s.trim()) ||
    /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(s.trim()) ||
    /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/.test(s.trim())
  );
}
