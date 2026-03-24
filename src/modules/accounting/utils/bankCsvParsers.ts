/**
 * PRD-060: FibreFlow Accounting Module
 * Bank CSV Statement Parsers
 *
 * Parsers for South African bank statement CSV formats:
 * - FNB (First National Bank)
 * - Standard Bank
 * - Nedbank
 * - ABSA
 * - Capitec
 */

import type { ParsedBankTransaction, BankCsvParseResult, BankFormat } from '../types/bank.types';

/**
 * Parse a CSV string into lines, handling quoted fields.
 */
function parseCsvLines(csv: string): string[][] {
  if (!csv || csv.trim() === '') return [];

  const lines = csv.trim().split('\n');
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
 */
function parseAmount(value: string): number | null {
  if (!value || value.trim() === '') return null;
  const cleaned = value.replace(/[,\s]/g, '').replace(/^["']|["']$/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Convert date string to YYYY-MM-DD format.
 */
function normalizeDate(dateStr: string, format: 'yyyy/mm/dd' | 'dd/mm/yyyy' | 'yyyy-mm-dd'): string | null {
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

  // Validate
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// ── FNB Parser ───────────────────────────────────────────────────────────────

/**
 * Parse FNB bank statement CSV.
 * Expected columns: Date, Description, Amount, Balance, Reference
 * Date format: YYYY/MM/DD
 * Amount: single column (positive = credit, negative = debit)
 */
export function parseFNBStatement(csv: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'fnb',
  };

  const lines = parseCsvLines(csv);
  if (lines.length <= 1) return result; // Empty or header only

  // Skip header (row 0)
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

    const tx: ParsedBankTransaction = {
      transactionDate: date,
      amount,
      description: fields[1]!.trim(),
      reference: fields.length > 4 ? fields[4]!.trim() || undefined : undefined,
      balance: fields.length > 3 ? parseAmount(fields[3]!) ?? undefined : undefined,
    };

    result.transactions.push(tx);
  }

  return result;
}

// ── Standard Bank Parser ─────────────────────────────────────────────────────

/**
 * Parse Standard Bank statement CSV.
 * Expected columns: Date, Description, Debit, Credit, Balance
 * Date format: DD/MM/YYYY
 * Separate debit/credit columns
 */
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

    const tx: ParsedBankTransaction = {
      transactionDate: date,
      amount,
      description: fields[1]!.trim(),
      balance: fields.length > 4 ? parseAmount(fields[4]!) ?? undefined : undefined,
    };

    result.transactions.push(tx);
  }

  return result;
}

// ── Nedbank Parser ───────────────────────────────────────────────────────────

/**
 * Parse Nedbank statement CSV.
 * Expected columns: Transaction Date, Value Date, Transaction Description, Debit Amount, Credit Amount, Balance
 * Date format: YYYY-MM-DD
 */
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

    const tx: ParsedBankTransaction = {
      transactionDate: date,
      valueDate: valueDate || undefined,
      amount,
      description: fields[2]!.trim(),
      balance: fields.length > 5 ? parseAmount(fields[5]!) ?? undefined : undefined,
    };

    result.transactions.push(tx);
  }

  return result;
}

// ── ABSA Parser ──────────────────────────────────────────────────────────────

/**
 * Parse ABSA bank statement CSV.
 * Expected columns: Account Number,Date,Description1,Description2,Amount,Balance
 * Date format: YYYY/MM/DD
 * Amount: single column with quoted strings, negative values in parentheses or with minus sign
 *
 * Example row:
 *   4087xxxxxx,2026/01/15,"POS Purchase","Woolworths Food","-1234.56","45678.90"
 */
export function parseABSAStatement(csv: string): BankCsvParseResult {
  const result: BankCsvParseResult = {
    transactions: [],
    errors: [],
    bankFormat: 'absa',
  };

  const lines = parseCsvLines(csv);
  if (lines.length <= 1) return result;

  // Skip header (row 0)
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i]!;
    // Minimum: AccountNumber, Date, Description1, Description2, Amount
    if (fields.length < 5) {
      if (fields.every(f => f === '')) continue; // skip blank lines
      result.errors.push({ row: i + 1, error: 'Insufficient columns' });
      continue;
    }

    // Column 1 = Date (YYYY/MM/DD)
    const date = normalizeDate(fields[1]!, 'yyyy/mm/dd');
    if (!date) {
      result.errors.push({ row: i + 1, error: `Invalid date: ${fields[1]}` });
      continue;
    }

    // Column 4 = Amount (column index 4)
    const amount = parseAmount(fields[4]!);
    if (amount === null) {
      result.errors.push({ row: i + 1, error: `Invalid amount: ${fields[4]}` });
      continue;
    }

    // Combine Description1 + Description2 for a richer description
    const desc1 = fields[2]!.trim();
    const desc2 = fields[3]!.trim();
    const description = desc2 ? `${desc1} ${desc2}`.trim() : desc1;

    const tx: ParsedBankTransaction = {
      transactionDate: date,
      amount,
      description,
      balance: fields.length > 5 ? parseAmount(fields[5]!) ?? undefined : undefined,
    };

    result.transactions.push(tx);
  }

  return result;
}

// ── Capitec Parser ────────────────────────────────────────────────────────────

/**
 * Parse Capitec bank statement CSV.
 * Expected columns: Date,Description,Debit,Credit,Balance
 * Date format: DD/MM/YYYY
 * Separate debit/credit columns (similar to Standard Bank but different header casing)
 */
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
    // Skip blank lines
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

    const tx: ParsedBankTransaction = {
      transactionDate: date,
      amount,
      description: fields[1]!.trim(),
      balance: fields.length > 4 ? parseAmount(fields[4]!) ?? undefined : undefined,
    };

    result.transactions.push(tx);
  }

  return result;
}

// ── Format Detection ─────────────────────────────────────────────────────────

/**
 * Detect bank format from CSV header line.
 * Returns 'ofx' or 'qif' when the content matches those non-CSV formats.
 */
export function detectBankFormat(csv: string): BankFormat {
  if (!csv || csv.trim() === '') return 'unknown';

  const trimmed = csv.trim();

  // OFX: starts with OFXHEADER: or <OFX>
  if (trimmed.startsWith('OFXHEADER:') || trimmed.startsWith('<OFX>') || trimmed.startsWith('<ofx>')) {
    return 'ofx';
  }

  // QIF: first non-blank line starts with !Type: or !Account
  const firstNonBlank = trimmed.split('\n').find(l => l.trim().length > 0) ?? '';
  if (firstNonBlank.startsWith('!Type:') || firstNonBlank.startsWith('!Account') || firstNonBlank.startsWith('!type:')) {
    return 'qif';
  }

  const firstLine = trimmed.split('\n')[0]!.toLowerCase();

  // ABSA: "Account Number,Date,Description1,Description2,Amount,Balance"
  if (firstLine.includes('account number') && firstLine.includes('description1')) {
    return 'absa';
  }

  // FNB: "Date","Description","Amount","Balance","Reference"
  if (firstLine.includes('"date"') && firstLine.includes('"amount"') && firstLine.includes('"reference"')) {
    return 'fnb';
  }

  // Nedbank: Transaction Date,Value Date,Transaction Description,...
  if (firstLine.includes('transaction date') && firstLine.includes('value date')) {
    return 'nedbank';
  }

  // Capitec: Date,Description,Debit,Credit,Balance (no extra qualifier columns)
  // Must be checked before Standard Bank since header is similar but Capitec has no extra columns.
  if (
    firstLine.includes('date') &&
    firstLine.includes('description') &&
    firstLine.includes('debit') &&
    firstLine.includes('credit') &&
    firstLine.includes('balance') &&
    !firstLine.includes('transaction date') &&
    !firstLine.includes('value date')
  ) {
    // Disambiguate: Standard Bank may include "Batch No" or similar extra fields.
    // Capitec typically has exactly 5 columns; Standard Bank also 5 — default to capitec
    // when header exactly matches Date,Description,Debit,Credit,Balance.
    const cols = firstLine.split(',').map(s => s.trim().replace(/"/g, ''));
    if (cols.length === 5 && cols[0] === 'date' && cols[1] === 'description') {
      return 'capitec';
    }
    return 'standard_bank';
  }

  // Standard Bank: Date,Description,Debit,Credit,Balance (fallback for variations)
  if (firstLine.includes('date') && firstLine.includes('debit') && firstLine.includes('credit')) {
    return 'standard_bank';
  }

  return 'unknown';
}
