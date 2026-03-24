/**
 * PRD-060: FibreFlow Accounting Module
 * QIF Bank Statement Parser
 *
 * Parses Quicken Interchange Format (QIF) files — a line-based text format
 * used by South African banks for statement exports.
 *
 * Line prefixes used:
 *   D  — Date (DD/MM/YYYY in SA)
 *   T  — Amount (negative = debit / money out, positive = credit / money in)
 *   P  — Payee / description
 *   N  — Cheque number / reference
 *   M  — Memo (supplementary description)
 *   ^  — End of record separator
 *
 * Records start after a !Type: header line and are separated by ^ characters.
 */

import { log } from '@/lib/logger';
import type { ParsedBankTransaction, BankCsvParseResult } from '../types/bank.types';

// ── Date Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse a QIF date string (DD/MM/YYYY or DD-MM-YYYY or DD/MM'YY) to YYYY-MM-DD.
 */
function parseQifDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const cleaned = dateStr.trim();

  // Try DD/MM/YYYY or DD-MM-YYYY
  const slashRe = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;
  const slashMatch = slashRe.exec(cleaned);
  if (slashMatch) {
    const day = slashMatch[1]!.padStart(2, '0');
    const month = slashMatch[2]!.padStart(2, '0');
    let year = slashMatch[3]!;
    if (year.length === 2) year = `20${year}`;

    const d = parseInt(day, 10);
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    if (isNaN(d) || isNaN(m) || isNaN(y)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;

    return `${year}-${month}-${day}`;
  }

  // Try MM/DD'YY (US QIF variant)
  const apostropheRe = /^(\d{1,2})\/(\d{1,2})'(\d{2,4})$/;
  const apostropheMatch = apostropheRe.exec(cleaned);
  if (apostropheMatch) {
    const month = apostropheMatch[1]!.padStart(2, '0');
    const day = apostropheMatch[2]!.padStart(2, '0');
    let year = apostropheMatch[3]!;
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }

  return null;
}

// ── Amount Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a QIF amount string.
 * Handles comma thousand separators and negative values.
 */
function parseQifAmount(amtStr: string): number | null {
  if (!amtStr || amtStr.trim() === '') return null;
  // Remove thousand-separator commas, strip surrounding whitespace
  const cleaned = amtStr.trim().replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ── Record Parser ─────────────────────────────────────────────────────────────

interface QifRecord {
  date?: string;
  amount?: number;
  payee?: string;
  memo?: string;
  reference?: string;
}

/**
 * Parse a single QIF record (block between ^ separators) into a QifRecord.
 */
function parseQifRecord(block: string): QifRecord {
  const record: QifRecord = {};
  const lines = block.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length < 2) continue;

    const prefix = line[0]!.toUpperCase();
    const value = line.slice(1).trim();

    switch (prefix) {
      case 'D':
        record.date = value;
        break;
      case 'T':
        record.amount = parseQifAmount(value) ?? undefined;
        break;
      case 'P':
        record.payee = value;
        break;
      case 'M':
        record.memo = value;
        break;
      case 'N':
        record.reference = value;
        break;
      default:
        break;
    }
  }

  return record;
}

// ── Main Parser ───────────────────────────────────────────────────────────────

/**
 * Parse a QIF bank statement file into a list of transactions.
 *
 * @param content - Raw QIF file content as string
 * @returns BankCsvParseResult with parsed transactions and any per-record errors
 */
export function parseQifStatement(content: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'qif',
  };

  if (!content || content.trim() === '') {
    result.errors.push({ row: 0, error: 'Empty QIF content' });
    return result;
  }

  // Normalise line endings
  const normalised = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split on ^ record separators — filter empty blocks
  const rawBlocks = normalised.split('^').map(b => b.trim()).filter(b => b.length > 0);

  if (rawBlocks.length === 0) {
    result.errors.push({ row: 0, error: 'No QIF records found (missing ^ separators)' });
    return result;
  }

  // The first block may be a header (!Type:Bank, !Account, etc.) — skip it
  const dataBlocks = rawBlocks.filter(b => !b.startsWith('!'));

  if (dataBlocks.length === 0) {
    result.errors.push({ row: 0, error: 'No data records found after QIF header' });
    return result;
  }

  dataBlocks.forEach((block, idx) => {
    const rowNum = idx + 1;
    const record = parseQifRecord(block);

    // Validate required fields
    if (!record.date) {
      result.errors.push({ row: rowNum, error: 'Missing D (date) line' });
      return;
    }

    const transactionDate = parseQifDate(record.date);
    if (!transactionDate) {
      result.errors.push({ row: rowNum, error: `Invalid date: ${record.date}` });
      return;
    }

    if (record.amount === undefined || record.amount === null) {
      result.errors.push({ row: rowNum, error: 'Missing T (amount) line' });
      return;
    }

    // Build description from P (payee) and M (memo), preferring payee
    const payee = record.payee?.trim() ?? '';
    const memo = record.memo?.trim() ?? '';
    let description = payee || memo;
    if (!description) description = 'QIF Transaction';

    const tx: ParsedBankTransaction = {
      transactionDate,
      amount: record.amount,
      description,
      reference: record.reference?.trim() || undefined,
    };

    result.transactions.push(tx);
  });

  log.info('Parsed QIF statement', {
    transactionCount: result.transactions.length,
    errorCount: result.errors.length,
  }, 'accounting');

  return result;
}
