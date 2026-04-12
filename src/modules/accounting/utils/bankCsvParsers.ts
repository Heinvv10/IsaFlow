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
 *   bankCsvParserStandard.ts — Standard Bank, Nedbank, ABSA, Capitec
 */

import type { BankFormat } from '../types/bank.types';

// ── Re-exports ────────────────────────────────────────────────────────────────

export { parseCsvLines, parseAmount, normalizeDate } from './bankCsvParserUtils';
export { parseFNBStatement } from './bankCsvParserFnb';
export {
  parseStandardBankStatement,
  parseNedbankStatement,
  parseABSAStatement,
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

  const firstLine = trimmed.split('\n')[0]!.toLowerCase();

  if (firstLine.includes('account number') && firstLine.includes('description1')) {
    return 'absa';
  }

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
