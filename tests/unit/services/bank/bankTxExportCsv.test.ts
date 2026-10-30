/**
 * The bank-transactions CSV: one builder for the per-account Export button and
 * the all-accounts export, so both files carry the same columns. The old
 * button wrapped values in quotes without escaping, so a description holding
 * a `"` shifted every later cell.
 */
import { describe, expect, it } from 'vitest';
import { BANK_TX_EXPORT_COLUMNS, bankTxExportCsv } from '@/modules/accounting/services/bank/bankTxExportCsv';
import type { BankTransaction } from '@/modules/accounting/types/bank.types';

function tx(over: Partial<BankTransaction>): BankTransaction {
  return {
    id: 'id', bankAccountId: 'bank', transactionDate: '2025-04-03', amount: -100,
    status: 'allocated', createdAt: '', updatedAt: '', ...over,
  } as BankTransaction;
}

/** Minimal RFC 4180 reader: enough to prove the cells round-trip. */
function parse(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows;
}

describe('bankTxExportCsv', () => {
  it('writes the header, then one row per transaction with every column', () => {
    const rows = parse(bankTxExportCsv([
      tx({
        bankAccountName: 'ABSA Current', description: 'Fuel', reference: 'R1', bankReference: 'BR1',
        amount: -250.5, allocatedEntityName: '5200 Fuel', cc1Code: 'CC-OPS', cc2Code: 'PRJ-1', buCode: 'BU-N',
      }),
      tx({ bankAccountName: 'FNB Savings', transactionDate: '2025-04-30', amount: 1000, status: 'imported' }),
    ]));
    expect(rows[0]).toEqual([...BANK_TX_EXPORT_COLUMNS]);
    const col = (r: string[], name: string) => r[BANK_TX_EXPORT_COLUMNS.indexOf(name as never)];
    expect(rows).toHaveLength(3);
    expect(col(rows[1], 'Bank Account')).toBe('ABSA Current');
    expect(col(rows[1], 'Spent')).toBe('250.50');
    expect(col(rows[1], 'Received')).toBe('');
    expect(col(rows[1], 'Allocated To')).toBe('5200 Fuel');
    expect(col(rows[1], 'Cost Centre (CC1)')).toBe('CC-OPS');
    expect(col(rows[1], 'Project (CC2)')).toBe('PRJ-1');
    expect(col(rows[1], 'Business Unit')).toBe('BU-N');
    expect(col(rows[2], 'Bank Account')).toBe('FNB Savings');
    expect(col(rows[2], 'Received')).toBe('1000.00');
    expect(col(rows[2], 'Spent')).toBe('');
    expect(col(rows[2], 'Status')).toBe('imported');
  });

  it('escapes quotes, commas and newlines so no cell spills into the next', () => {
    const rows = parse(bankTxExportCsv([tx({ description: 'Pay "J, Smith"\nApril' })]));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveLength(BANK_TX_EXPORT_COLUMNS.length);
    expect(rows[1][BANK_TX_EXPORT_COLUMNS.indexOf('Description')]).toBe('Pay "J, Smith"\nApril');
  });

  it('labels a split dimension set instead of leaving it blank', () => {
    const rows = parse(bankTxExportCsv([tx({ dimensionSource: 'split' })]));
    expect(rows[1][BANK_TX_EXPORT_COLUMNS.indexOf('Cost Centre (CC1)')]).toBe('Split');
    expect(rows[1][BANK_TX_EXPORT_COLUMNS.indexOf('Business Unit')]).toBe('Split');
  });

  it('is a header-only file when there are no transactions', () => {
    expect(parse(bankTxExportCsv([]))).toEqual([[...BANK_TX_EXPORT_COLUMNS]]);
  });
});

describe('bankTxExportCsv on one account', () => {
  it('labels rows without a bank account name with the account given', () => {
    const rows = parse(bankTxExportCsv([tx({})], 'ABSA Current'));
    expect(rows[1][BANK_TX_EXPORT_COLUMNS.indexOf('Bank Account')]).toBe('ABSA Current');
  });
});
