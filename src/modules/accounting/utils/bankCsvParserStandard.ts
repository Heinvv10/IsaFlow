/**
 * Bank CSV Parser — Standard Bank + Nedbank + Capitec
 * Groups parsers for banks using debit/credit column formats.
 * ABSA lives in bankCsvParserAbsa.ts — it is header-mapped, not positional.
 */

import type { BankCsvParseResult } from '../types/bank.types';
import { parseCsvLines, parseAmount, normalizeDate } from './bankCsvParserUtils';

// ── Standard Bank ─────────────────────────────────────────────────────────────
// Columns: Date, Description, Debit, Credit, Balance
// Date format: DD/MM/YYYY

export function parseStandardBankStatement(csv: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'standard_bank',
  };

  const lines = parseCsvLines(csv);
  if (lines.length <= 1) return result;

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!;
    if (fields.length < 4) {
      result.errors.push({ row: i + 1, error: 'Insufficient columns' });
      continue;
    }

    const date = normalizeDate(fields[0]!, 'dd/mm/yyyy');
    if (!date) {
      result.errors.push({ row: i + 1, error: `Invalid date: ${fields[0]}` });
      continue;
    }

    const debit = parseAmount(fields[2]!);
    const credit = parseAmount(fields[3]!);

    let amount: number;
    if (credit !== null && credit > 0) {
      amount = credit;
    } else if (debit !== null && debit > 0) {
      amount = -debit;
    } else if (credit === null && debit === null) {
      result.errors.push({ row: i + 1, error: 'No debit or credit amount' });
      continue;
    } else {
      amount = 0;
    }

    result.transactions.push({
      transactionDate: date,
      amount,
      description: fields[1]!.trim(),
      balance: fields.length > 4 ? parseAmount(fields[4]!) ?? undefined : undefined,
    });
  }

  return result;
}

// ── Nedbank ───────────────────────────────────────────────────────────────────
// Columns: Transaction Date, Value Date, Transaction Description, Debit Amount, Credit Amount, Balance
// Date format: YYYY-MM-DD

export function parseNedbankStatement(csv: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'nedbank',
  };

  const lines = parseCsvLines(csv);
  if (lines.length <= 1) return result;

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!;
    if (fields.length < 5) {
      result.errors.push({ row: i + 1, error: 'Insufficient columns' });
      continue;
    }

    const date = normalizeDate(fields[0]!, 'yyyy-mm-dd');
    if (!date) {
      result.errors.push({ row: i + 1, error: `Invalid date: ${fields[0]}` });
      continue;
    }

    const valueDate = normalizeDate(fields[1]!, 'yyyy-mm-dd');
    const debit = parseAmount(fields[3]!);
    const credit = parseAmount(fields[4]!);

    let amount: number;
    if (credit !== null && credit > 0) {
      amount = credit;
    } else if (debit !== null && debit > 0) {
      amount = -debit;
    } else {
      amount = 0;
    }

    result.transactions.push({
      transactionDate: date,
      valueDate: valueDate || undefined,
      amount,
      description: fields[2]!.trim(),
      balance: fields.length > 5 ? parseAmount(fields[5]!) ?? undefined : undefined,
    });
  }

  return result;
}

// ── Capitec ───────────────────────────────────────────────────────────────────
// Columns: Date, Description, Debit, Credit, Balance
// Date format: DD/MM/YYYY

export function parseCapitecStatement(csv: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'capitec',
  };

  const lines = parseCsvLines(csv);
  if (lines.length <= 1) return result;

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!;
    if (fields.every(f => f === '')) continue;
    if (fields.length < 4) {
      result.errors.push({ row: i + 1, error: 'Insufficient columns' });
      continue;
    }

    const date = normalizeDate(fields[0]!, 'dd/mm/yyyy');
    if (!date) {
      result.errors.push({ row: i + 1, error: `Invalid date: ${fields[0]}` });
      continue;
    }

    const debit = parseAmount(fields[2]!);
    const credit = parseAmount(fields[3]!);

    let amount: number;
    if (credit !== null && credit > 0) {
      amount = credit;
    } else if (debit !== null && debit > 0) {
      amount = -debit;
    } else if (credit === null && debit === null) {
      result.errors.push({ row: i + 1, error: 'No debit or credit amount' });
      continue;
    } else {
      amount = 0;
    }

    result.transactions.push({
      transactionDate: date,
      amount,
      description: fields[1]!.trim(),
      balance: fields.length > 4 ? parseAmount(fields[4]!) ?? undefined : undefined,
    });
  }

  return result;
}
