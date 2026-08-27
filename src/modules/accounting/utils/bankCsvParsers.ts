/**
 * PRD-060: FibreFlow Accounting Module
 * Bank CSV Statement Parsers — Dispatcher / Index
 *
 * Re-exports all bank-specific parsers and shared utilities so existing callers
 * work unchanged. Also owns format detection logic.
 *
 * Parser modules:
 *   bankCsvParserUtils.ts    — parseCsvLines, parseAmount, normalizeDate
 *   bankCsvParserFnb.ts      — FNB
 *   bankCsvParserStandard.ts — Standard Bank, Nedbank, Capitec
 *   bankCsvParserAbsa.ts     — ABSA (header-mapped: two layouts in the wild)
 */

import type { BankFormat } from '../types/bank.types';

/**
 * Find the CSV header line. Real exports (ABSA in particular) print a title
 * line — "ABSA BANK LIMITED - TRANSACTION HISTORY" — above the column names, so
 * reading line 0 alone meant detection saw a title and gave up. Scan the first
 * few non-blank lines for one that carries recognisable column names; fall back
 * to the first non-blank line so existing single-header files are unaffected.
 */
function findHeaderLine(trimmed: string): string {
  const lines = trimmed.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const candidate = lines
    .slice(0, 6)
    .find(l => /(^|,)\s*"?(transaction )?date"?\s*(,|$)/i.test(l) && l.includes(','));
  return (candidate ?? lines[0] ?? '').toLowerCase();
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export { parseCsvLines, parseAmount, normalizeDate, normalizeDateFlexible } from './bankCsvParserUtils';
export { parseFNBStatement } from './bankCsvParserFnb';
export { parseABSAStatement } from './bankCsvParserAbsa';
export {
  parseStandardBankStatement,
  parseNedbankStatement,
  parseCapitecStatement,
} from './bankCsvParserStandard';

// ── Format Detection ──────────────────────────────────────────────────────────

/**
 * Detect bank format from CSV header line.
 * Returns 'ofx' or 'qif' when the content matches those non-CSV formats.
 */
export function detectBankFormat(csv: string): BankFormat {
  if (!csv || csv.trim() === '') return 'unknown';

  const trimmed = csv.trim();

  if (trimmed.startsWith('OFXHEADER:') || trimmed.startsWith('<OFX>') || trimmed.startsWith('<ofx>')) {
    return 'ofx';
  }

  const firstNonBlank = trimmed.split('\n').find(l => l.trim().length > 0) ?? '';
  if (firstNonBlank.startsWith('!Type:') || firstNonBlank.startsWith('!Account') || firstNonBlank.startsWith('!type:')) {
    return 'qif';
  }

  const firstLine = findHeaderLine(trimmed);

  // ABSA ships two layouts: the legacy Description1/Description2 one and the
  // current single-Description one. Both lead with "Account Number", which no
  // other SA preset here carries; requiring an Amount column (and no
  // debit/credit pair) keeps this from swallowing a debit/credit statement that
  // happens to name the account.
  const isAbsaHeader =
    firstLine.includes('account number') &&
    (firstLine.includes('description1') ||
      (firstLine.includes('description') &&
        firstLine.includes('amount') &&
        !(firstLine.includes('debit') && firstLine.includes('credit'))));
  if (isAbsaHeader) return 'absa';

  if (firstLine.includes('"date"') && firstLine.includes('"amount"') && firstLine.includes('"reference"')) {
    return 'fnb';
  }

  if (firstLine.includes('transaction date') && firstLine.includes('value date')) {
    return 'nedbank';
  }

  if (
    firstLine.includes('date') &&
    firstLine.includes('description') &&
    firstLine.includes('debit') &&
    firstLine.includes('credit') &&
    firstLine.includes('balance') &&
    !firstLine.includes('transaction date') &&
    !firstLine.includes('value date')
  ) {
    const cols = firstLine.split(',').map(s => s.trim().replace(/"/g, ''));
    if (cols.length === 5 && cols[0] === 'date' && cols[1] === 'description') {
      return 'capitec';
    }
    return 'standard_bank';
  }

  if (firstLine.includes('date') && firstLine.includes('debit') && firstLine.includes('credit')) {
    return 'standard_bank';
  }

  return 'unknown';
}
