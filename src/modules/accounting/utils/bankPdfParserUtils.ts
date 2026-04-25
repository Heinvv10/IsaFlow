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
 * Extract account number from bank statement text.
 *
 * Strategy:
 *
 *   Pass 1 — LABELLED match. Looks for "Account Number: 12345678",
 *   "Acc No: …", "A/C …". When the label and digits land on the same
 *   pdf-parse line this is the authoritative answer.
 *
 *   Pass 2 — FREQUENCY-RANKED fallback. Account numbers appear in the
 *   header/footer of EVERY page of an SA bank statement (the legacy
 *   "first 9-13 digit number" heuristic mis-picks transaction
 *   reference numbers, which appear once each). We count every 9-13
 *   digit token, subtract scores for tokens that appear adjacent to
 *   known false-positive labels (VAT registration, telephone, branch
 *   codes), and return the highest-scoring candidate.
 *
 * Returns the number with spaces/dashes stripped, or null if nothing
 * plausible is found.
 */
export function extractAccountNumber(text: string): string | null {
  // Pass 1: labelled patterns
  const labelledPatterns = [
    /account\s+(?:number|no\.?|num\.?)\s*[:-]?\s*(\d[\d\s-]{4,20})/i,
    /acc(?:ount)?\s*(?:no\.?|num\.?|#)\s*[:-]?\s*(\d[\d\s-]{4,20})/i,
    /\bA\/C\s*[:-]?\s*(\d[\d\s-]{4,20})/i,
  ];
  for (const pattern of labelledPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const cleaned = match[1].replace(/[\s-]/g, '').trim();
      if (cleaned.length >= 6 && !isLikelyNonAccountToken(text, cleaned)) {
        return cleaned;
      }
    }
  }

  // Pass 2: page-header marker pattern. ABSA (and several other SA
  // banks) print a per-page header like "VFIBRE 001 4118819618 0001"
  // — entity name, branch code, account number, statement number.
  // The third token is the account. Whichever digit token shows up in
  // this pattern most often is the account number — it appears once
  // per page, and is far more reliable than raw frequency since
  // counterparty accounts in transaction lines also recur.
  const headerPattern = /\b[A-Z][A-Z0-9 ]{2,40}\s+\d{3}\s+(\d{9,13})\s+\d{3,5}\b/g;
  const headerHits = new Map<string, number>();
  let headerMatch: RegExpExecArray | null;
  while ((headerMatch = headerPattern.exec(text)) !== null) {
    const token = headerMatch[1]!;
    if (!isLikelyNonAccountToken(text, token)) {
      headerHits.set(token, (headerHits.get(token) ?? 0) + 1);
    }
  }
  if (headerHits.size > 0) {
    let bestHeader: string | null = null;
    let bestHeaderCount = 0;
    for (const [token, count] of headerHits) {
      if (count > bestHeaderCount) {
        bestHeader = token;
        bestHeaderCount = count;
      }
    }
    if (bestHeader) return bestHeader;
  }

  // Pass 3: header-biased frequency fallback. Account numbers always
  // appear in the document header/footer block; transaction reference
  // numbers and counterparty accounts dominate the body but rarely
  // appear in the first ~3000 chars. We score every 9-13 digit token
  // by frequency, give a heavy bonus to tokens that appear at all in
  // the header region, and treat a 9-digit token as the same account
  // as a 13-digit token that ends with it (Standard Bank prints the
  // canonical 13-digit form `0000310650550` in the header but a
  // 9-digit suffix `310650550` in some downstream rows).
  const tokens = text.match(/\b\d{9,13}\b/g);
  if (!tokens || tokens.length === 0) return null;

  const HEADER_WINDOW = 3000;
  const headerText = text.slice(0, HEADER_WINDOW);
  const headerTokenSet = new Set(headerText.match(/\b\d{9,13}\b/g) ?? []);

  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);

  // Canonicalise: if token A is a suffix of a longer token B that also
  // appears, fold A's count into B and drop A. This handles the
  // "0000310650550" vs "310650550" leading-zero case without affecting
  // legitimately distinct accounts (a 9-digit account that happens to
  // be the suffix of an unrelated 13-digit token in the same document
  // is vanishingly rare and would still be excluded by the header-bias
  // tiebreak below).
  for (const a of [...counts.keys()]) {
    for (const b of counts.keys()) {
      if (a === b) continue;
      if (b.length > a.length && b.endsWith(a)) {
        counts.set(b, (counts.get(b) ?? 0) + (counts.get(a) ?? 0));
        counts.delete(a);
        break;
      }
    }
  }

  let best: string | null = null;
  let bestScore = -Infinity;
  for (const [token, count] of counts) {
    if (isLikelyNonAccountToken(text, token)) continue;
    // Header presence is worth more than any plausible body-frequency
    // delta on a real bank statement (rarely more than ~50 occurrences
    // total). 1000 dominates the count term cleanly.
    const headerBias = headerTokenSet.has(token) ? 1000 : 0;
    const score = count + headerBias;
    if (score > bestScore || (score === bestScore && best !== null && token.length > best.length)) {
      best = token;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Heuristic: does this digit string sit adjacent to a label that
 * strongly suggests it is NOT an account number? VAT registration
 * numbers, company registration numbers, telephone numbers and SARS
 * tax reference numbers all match the 9-13 digit shape and tend to
 * appear in every bank statement page header alongside the real
 * account number.
 */
function isLikelyNonAccountToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Look at the 60 chars immediately preceding the token. If any of
  // these labels appear in that window, treat the token as a false
  // positive for account-number extraction.
  const re = new RegExp(
    '(vat\\s+(?:registration|reg)\\s*(?:no\\.?|num(?:ber)?)?|registration\\s+number|tax\\s+(?:reference|ref)|tel(?:ephone)?\\s*(?:no\\.?|number)?|telephone|branch\\s+code|reg\\s*no\\.?)' +
      '[^\\d]{0,60}?\\b' + escaped + '\\b',
    'i',
  );
  return re.test(text);
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
