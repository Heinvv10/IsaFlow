/**
 * Bank CSV Parser — FNB (First National Bank)
 * Date format: YYYY/MM/DD
 * Columns: Date, Description, Amount, Balance, Reference
 * Amount: single column (positive = credit, negative = debit)
 */

import type { BankCsvParseResult } from '../types/bank.types';
import { parseCsvLines, parseAmount, normalizeDate } from './bankCsvParserUtils';

export function parseFNBStatement(csv: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'fnb',
  };

  const lines = parseCsvLines(csv);
  if (lines.length <= 1) return result;

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!;
    if (fields.length < 3) {
      result.errors.push({ row: i + 1, error: 'Insufficient columns' });
      continue;
    }

    const date = normalizeDate(fields[0]!, 'yyyy/mm/dd');
    if (!date) {
      result.errors.push({ row: i + 1, error: `Invalid date: ${fields[0]}` });
      continue;
    }

    const amount = parseAmount(fields[2]!);
    if (amount === null) {
      result.errors.push({ row: i + 1, error: `Invalid amount: ${fields[2]}` });
      continue;
    }

    result.transactions.push({
      transactionDate: date,
      amount,
      description: fields[1]!.trim(),
      reference: fields.length > 4 ? fields[4]!.trim() || undefined : undefined,
      balance: fields.length > 3 ? parseAmount(fields[3]!) ?? undefined : undefined,
    });
  }

  return result;
}
