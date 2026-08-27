/**
 * Bank CSV Parser — ABSA
 *
 * ABSA exports two layouts and both turn up in migrations:
 *   legacy   Account Number,Date,Description1,Description2,Amount,Balance
 *   current  Account Number,Transaction Date,Description,Amount,Balance
 *
 * Positional parsing only ever fitted the legacy one, so a current-layout
 * export lost its amount column (or was rejected outright by detection). This
 * parser maps columns by HEADER NAME and falls back to the legacy positions
 * when the header is unrecognisable, so both keep working. Dates arrive as
 * either YYYY/MM/DD or DD/MM/YYYY; amounts as -1234.56 or "1 234,56".
 */

import type { BankCsvParseResult, ParsedBankTransaction } from '../types/bank.types';
import { parseCsvLines, parseAmount, normalizeDateFlexible } from './bankCsvParserUtils';

/** Column positions of the legacy 6-column layout, used when no header matches. */
const LEGACY_COLUMNS: AbsaColumns = { date: 1, descriptions: [2, 3], amount: 4, balance: 5 };

interface AbsaColumns {
  date: number;
  descriptions: number[];
  amount: number;
  balance: number | null;
}

/** True when the row is padding rather than data: blank, or a trailing total. */
function isNoiseRow(fields: string[]): boolean {
  if (fields.every(f => f.trim() === '')) return true;
  const first = fields[0]!.trim().toLowerCase();
  return first === 'total' || first === 'totals' || first === 'closing balance';
}

/**
 * Map ABSA column indices from a header row. Returns null when the row does not
 * look like an ABSA header at all (no date column and no amount column).
 */
export function mapAbsaColumns(header: string[]): AbsaColumns | null {
  const cols = header.map(h => h.trim().toLowerCase().replace(/\s+/g, ' '));

  const date = cols.findIndex(c => c === 'date' || c === 'transaction date' || c === 'posting date');
  const amount = cols.findIndex(c => c === 'amount' || c === 'transaction amount');
  if (date === -1 || amount === -1) return null;

  const descriptions = cols
    .map((c, i) => (c.startsWith('description') || c === 'narrative' || c === 'details' ? i : -1))
    .filter(i => i !== -1);
  if (descriptions.length === 0) return null;

  const balance = cols.findIndex(c => c === 'balance' || c === 'running balance');

  return { date, descriptions, amount, balance: balance === -1 ? null : balance };
}

/** Locate the header row: real exports put a title line or two above it. */
function findHeaderRow(lines: string[][]): number {
  const limit = Math.min(lines.length, 6);
  for (let i = 0; i < limit; i++) {
    if (mapAbsaColumns(lines[i]!)) return i;
    if (lines[i]!.some(f => f.trim().toLowerCase() === 'description1')) return i;
  }
  return 0;
}

export function parseABSAStatement(csv: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'absa',
  };

  const lines = parseCsvLines(csv);
  if (lines.length <= 1) return result;

  const headerRow = findHeaderRow(lines);
  const columns = mapAbsaColumns(lines[headerRow]!) ?? LEGACY_COLUMNS;
  const needed = Math.max(columns.date, columns.amount, ...columns.descriptions) + 1;

  for (let i = headerRow + 1; i < lines.length; i++) {
    const fields = lines[i]!;
    if (isNoiseRow(fields)) continue;

    if (fields.length < needed) {
      result.errors.push({ row: i + 1, error: 'Insufficient columns' });
      continue;
    }

    const date = normalizeDateFlexible(fields[columns.date]!);
    if (!date) {
      result.errors.push({ row: i + 1, error: `Invalid date: ${fields[columns.date]}` });
      continue;
    }

    const amount = parseAmount(fields[columns.amount]!);
    if (amount === null) {
      result.errors.push({ row: i + 1, error: `Invalid amount: ${fields[columns.amount]}` });
      continue;
    }

    const description = columns.descriptions
      .map(idx => fields[idx]?.trim() ?? '')
      .filter(part => part !== '')
      .join(' ')
      .trim();

    const tx: ParsedBankTransaction = {
      transactionDate: date,
      amount,
      description,
    };

    if (columns.balance !== null && fields.length > columns.balance) {
      const balance = parseAmount(fields[columns.balance]!);
      if (balance !== null) tx.balance = balance;
    }

    result.transactions.push(tx);
  }

  return result;
}
