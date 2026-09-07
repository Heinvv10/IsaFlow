/**
 * Bank CSV Parser — header-mapped engine, and the `generic` format built on it.
 *
 * Extracted from the ABSA parser, which had already stopped being ABSA-specific:
 * it maps columns by HEADER NAME (date / description / amount / balance) and
 * never looked at the bank's name to do it. That is why it reads a plain
 * `Date,Description,Amount,Balance` export correctly — and why the import bug
 * was in DETECTION alone, not in parsing.
 *
 * So the mapping lives here and both callers share it:
 *   generic — any header carrying a date, an amount and a description
 *   absa    — the same, plus a positional fallback for the legacy 6-column
 *             layout whose header is unrecognisable
 *
 * The `generic` format is deliberately the LAST format detection tries. A
 * debit/credit layout read as a single-amount one loses the sign on every
 * debit, so the specific presets must keep winning.
 */

import type { BankCsvParseResult, ParsedBankTransaction } from '../types/bank.types';
import { parseCsvLines, parseAmount, normalizeDateFlexible } from './bankCsvParserUtils';

export interface MappedColumns {
  date: number;
  descriptions: number[];
  amount: number;
  balance: number | null;
  /**
   * The statement reference column, or null when the layout has none.
   *
   * It used to have no mapping at all, so a `Reference` column was read and
   * discarded and every imported row carried a null reference. That is the only
   * stable key the CALLER controls — it is what `bank_reference` resolves a
   * transaction by — so losing it forces an importer to re-list every row and
   * rebuild an id map on (date, amount, description) instead.
   */
  reference: number | null;
}

/**
 * Header names that carry a statement reference.
 *
 * Matched EXACTLY, not by prefix, unlike `description`. `reference` sits next
 * to columns whose names contain it — "reference number" is one, but so is
 * ABSA's "account reference" — and a prefix rule that swallowed a second one
 * would silently pick whichever came first.
 */
const REFERENCE_HEADERS = [
  'reference',
  'ref',
  'ref no',
  'ref number',
  'reference no',
  'reference number',
  'payment reference',
  'transaction reference',
  'statement reference',
  'your reference',
] as const;

/**
 * Map column indices from a header row, or null when the row is not a usable
 * header — no date column, no amount column, or nothing to describe the line
 * with. Null is what makes "generic" a claim about the layout rather than about
 * any file containing commas.
 */
export function mapCsvColumns(header: string[]): MappedColumns | null {
  const cols = header.map(h => h.trim().toLowerCase().replace(/\s+/g, ' '));

  const date = cols.findIndex(c => c === 'date' || c === 'transaction date' || c === 'posting date');
  const amount = cols.findIndex(c => c === 'amount' || c === 'transaction amount');
  if (date === -1 || amount === -1) return null;

  const descriptions = cols
    .map((c, i) => (c.startsWith('description') || c === 'narrative' || c === 'details' ? i : -1))
    .filter(i => i !== -1);
  if (descriptions.length === 0) return null;

  const balance = cols.findIndex(c => c === 'balance' || c === 'running balance');
  const reference = cols.findIndex(c => (REFERENCE_HEADERS as readonly string[]).includes(c));

  return {
    date,
    descriptions,
    amount,
    balance: balance === -1 ? null : balance,
    reference: reference === -1 ? null : reference,
  };
}

/** True when the row is padding rather than data: blank, or a trailing total. */
function isNoiseRow(fields: string[]): boolean {
  if (fields.every(f => f.trim() === '')) return true;
  const first = fields[0]!.trim().toLowerCase();
  return first === 'total' || first === 'totals' || first === 'closing balance';
}

/**
 * Locate the header row. Real exports print a title line or two above it —
 * "ABSA BANK LIMITED - TRANSACTION HISTORY" — so reading row 0 alone gave up on
 * a file that was perfectly readable two lines down.
 */
function findHeaderRow(lines: string[][], legacyMarker?: string): number {
  const limit = Math.min(lines.length, 6);
  for (let i = 0; i < limit; i++) {
    if (mapCsvColumns(lines[i]!)) return i;
    if (legacyMarker && lines[i]!.some(f => f.trim().toLowerCase() === legacyMarker)) return i;
  }
  return 0;
}

export interface HeaderMappedOptions {
  /** Value written to `result.bankFormat`. */
  bankFormat: string;
  /** Column positions to use when no header row maps — ABSA's legacy layout. */
  fallbackColumns?: MappedColumns;
  /** A header cell that identifies the fallback layout (e.g. 'description1'). */
  legacyMarker?: string;
}

/**
 * Parse a header-mapped statement CSV.
 *
 * Row-level faults are collected into `errors` rather than thrown: one
 * unparseable row in a 400-row statement must not cost the other 399. The
 * caller decides what an empty `transactions` means — `parseStatement` treats it
 * as a failed import, because a statement that yields nothing is never the
 * outcome the user wanted.
 */
export function parseHeaderMappedCsv(
  csv: string,
  options: HeaderMappedOptions,
): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: options.bankFormat,
  };

  const lines = parseCsvLines(csv);
  if (lines.length <= 1) return result;

  const headerRow = findHeaderRow(lines, options.legacyMarker);
  const columns = mapCsvColumns(lines[headerRow]!) ?? options.fallbackColumns;
  if (!columns) return result;
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

    const tx: ParsedBankTransaction = { transactionDate: date, amount, description };

    // Left UNSET rather than set to '' when the cell is blank. The column is
    // written straight through to `bank_transactions.reference`, and an empty
    // string there is a value that resolves nothing while reading as present.
    if (columns.reference !== null && fields.length > columns.reference) {
      const reference = fields[columns.reference]!.trim();
      if (reference !== '') tx.reference = reference;
    }

    if (columns.balance !== null && fields.length > columns.balance) {
      const balance = parseAmount(fields[columns.balance]!);
      if (balance !== null) tx.balance = balance;
    }

    result.transactions.push(tx);
  }

  return result;
}

/**
 * The bank-agnostic layout: a date, a description, an amount, optionally a
 * balance. What every SA bank's "export to CSV" produces, and the one layout
 * detection used to have no branch for.
 */
export function parseGenericStatement(csv: string): BankCsvParseResult {
  return parseHeaderMappedCsv(csv, { bankFormat: 'generic' });
}
