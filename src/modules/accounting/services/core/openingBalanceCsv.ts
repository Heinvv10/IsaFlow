/**
 * Reading an opening trial balance CSV for the migration wizard.
 *
 * The page used to read `r['debit']`, `r['code']`... case-sensitively, so a
 * Sage export headed "Account Code, Debit, Credit" came through as blank rows
 * and the import button sat disabled with no explanation. Headers are now
 * matched ignoring case, spaces, underscores and punctuation, against the
 * aliases real exports use, and a file without the required columns gets a
 * message naming what was expected.
 *
 * Amounts go through `parseAmount`: an unreadable amount is a row error, never
 * a silent 0. Pure — no database, safe on the client.
 */

import { parseAmount } from '@/lib/parseAmount';

export interface OpeningBalanceCsvRow {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

export interface OpeningBalanceColumns {
  code?: string;
  name?: string;
  debit?: string;
  credit?: string;
  /** A single signed column: positive is a debit, negative (or "Cr") a credit. */
  balance?: string;
}

export interface OpeningBalanceCsvIssue {
  /** 1-based data row (the first row under the header is 1). */
  row: number;
  message: string;
}

export interface OpeningBalanceCsvResult {
  rows: OpeningBalanceCsvRow[];
  errors: OpeningBalanceCsvIssue[];
  columns: OpeningBalanceColumns;
  /** Set when the file lacks the columns the step needs; rows is then empty. */
  missingColumnsMessage: string | null;
}

const ALIASES: Record<keyof OpeningBalanceColumns, string[]> = {
  code: ['accountcode', 'code', 'accountnumber', 'accountno', 'accno', 'accnumber', 'acccode', 'glcode', 'glaccount', 'account'],
  name: ['accountname', 'name', 'description', 'accountdescription', 'account'],
  debit: ['debit', 'dr', 'debitbalance', 'debitamount', 'debits'],
  credit: ['credit', 'cr', 'creditbalance', 'creditamount', 'credits'],
  balance: ['balance', 'closingbalance', 'netbalance', 'currentbalance'],
};

export const EXPECTED_OPENING_BALANCE_HEADERS =
  'an account code column (e.g. "Account Code", "Code", "Account", "Account Number" or "Acc No") and either '
  + '"Debit" and "Credit" columns (or "Dr" / "Cr", "Debit Balance" / "Credit Balance") or a single '
  + '"Balance" / "Closing Balance" column where positive is a debit and negative a credit';

function headerKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function detectOpeningBalanceColumns(fields: string[]): OpeningBalanceColumns {
  const used = new Set<string>();
  const cols: OpeningBalanceColumns = {};
  const pick = (field: keyof OpeningBalanceColumns) => {
    for (const alias of ALIASES[field]) {
      const hit = fields.find(f => !used.has(f) && headerKey(f) === alias);
      if (hit) { used.add(hit); cols[field] = hit; return; }
    }
  };
  // Code before name: a bare "Account" header is the code when nothing better is there.
  pick('code'); pick('debit'); pick('credit'); pick('balance'); pick('name');
  return cols;
}

/** A value written with a "Cr" / "Dr" marker is that side's amount whatever column it sits in. */
const MARKER = /(cr|dr)\s*$/i;

function splitSigned(value: number): { debit: number; credit: number } {
  return value >= 0 ? { debit: value, credit: 0 } : { debit: 0, credit: -value };
}

export function parseOpeningBalanceCsv(
  data: Array<Record<string, string | undefined>>,
  fields: string[],
): OpeningBalanceCsvResult {
  const columns = detectOpeningBalanceColumns(fields);
  const hasAmounts = Boolean(columns.balance || columns.debit || columns.credit);
  if (!columns.code || !hasAmounts) {
    return {
      rows: [], errors: [], columns,
      missingColumnsMessage: `Could not find the required columns. Expected ${EXPECTED_OPENING_BALANCE_HEADERS}. `
        + `Found: ${fields.length > 0 ? fields.map(f => `"${f}"`).join(', ') : 'no header row'}.`,
    };
  }

  const rows: OpeningBalanceCsvRow[] = [];
  const errors: OpeningBalanceCsvIssue[] = [];
  const cell = (r: Record<string, string | undefined>, col?: string) => (col ? String(r[col] ?? '').trim() : '');

  data.forEach((r, i) => {
    const rowNo = i + 1;
    const code = cell(r, columns.code);
    const name = cell(r, columns.name);
    const rawDebit = cell(r, columns.debit);
    const rawCredit = cell(r, columns.credit);
    const rawBalance = cell(r, columns.balance);

    const bad: string[] = [];
    const read = (label: string, raw: string): number => {
      const n = parseAmount(raw);
      if (Number.isNaN(n)) { bad.push(`${label} "${raw}" is not a number`); return 0; }
      return n;
    };

    let debit = 0;
    let credit = 0;
    if (columns.debit || columns.credit) {
      const d = splitSigned(read('debit', rawDebit));
      const creditValue = read('credit', rawCredit);
      // "200 Cr" in the credit column is a credit of 200 and "200 Dr" a debit of 200;
      // only an unmarked value takes its side from the column.
      const marker = MARKER.exec(rawCredit)?.[1]?.toLowerCase();
      const c = marker === 'cr' ? { debit: 0, credit: Math.abs(creditValue) }
        : marker === 'dr' ? { debit: Math.abs(creditValue), credit: 0 }
        : splitSigned(-creditValue);
      debit = d.debit + c.debit;
      credit = d.credit + c.credit;
    }
    if (columns.balance && rawBalance !== '' && !(columns.debit || columns.credit)) {
      const b = splitSigned(read('balance', rawBalance));
      debit = b.debit;
      credit = b.credit;
    }

    if (bad.length > 0) {
      errors.push({ row: rowNo, message: `Row ${rowNo}${code ? ` (account ${code})` : ''}: ${bad.join('; ')}` });
      return;
    }
    if (!code) {
      // A trailing "Total" line is the export's own summary, not an account.
      if (debit === 0 && credit === 0) return;
      if (/^total/i.test(name)) return;
      errors.push({ row: rowNo, message: `Row ${rowNo}: has an amount but no account code` });
      return;
    }
    rows.push({ accountCode: code, accountName: name, debit, credit });
  });

  return { rows, errors, columns, missingColumnsMessage: null };
}
