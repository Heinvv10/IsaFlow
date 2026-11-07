/**
 * A supplier statement's "Balance brought forward" line is an opening-balance check, not an invoice
 * (Hein, 2026-11-07, D1): never matched, never counted missing in IsaFlow. Detection is by wording AND
 * position: only dated lines on or before the first dated transaction qualify.
 */
import { describe, expect, it } from 'vitest';
import {
  isOpeningBalanceWording,
  openingBalanceAsAt,
  openingBalanceIndexes,
} from '@/modules/accounting/services/capture/supplierStatementOpeningBalance';
import { buildInserts, type InvoiceRecord } from '@/modules/accounting/services/capture/supplierStatementMatchHelper';

describe('isOpeningBalanceWording', () => {
  it.each([
    'Balance brought forward', 'BALANCE B/F', 'balance b/f', 'Brought forward', 'Opening balance', 'OPENING BALANCE',
    'B/FWD', 'balance b/fwd', '  Balance   brought  forward. ', 'Opening balance:',
  ])('%j is opening-balance wording', (text) => {
    expect(isOpeningBalanceWording(text)).toBe(true);
  });

  it.each([
    'Invoice 123 brought forward from March', 'Tax invoice', 'Payment - balance brought forward', 'Opening balance adjustment',
    'Brought forward balance correction', 'b/f', '', null, undefined,
  ])('%j is not', (text) => {
    expect(isOpeningBalanceWording(text)).toBe(false);
  });
});

describe('openingBalanceIndexes', () => {
  it('the first dated line worded as a balance brought forward is the opening balance', () => {
    expect(openingBalanceIndexes([
      { date: '2026-01-01', reference: 'OPENING BALANCE', description: 'Balance brought forward' },
      { date: '2026-02-05', reference: 'INV-1', description: 'Tax invoice' },
    ])).toEqual(new Set([0]));
  });

  it('the wording on the reference alone is enough', () => {
    expect(openingBalanceIndexes([
      { date: '2026-01-01', reference: 'Balance b/f', description: null },
      { date: '2026-02-05', reference: 'INV-1', description: 'Tax invoice' },
    ])).toEqual(new Set([0]));
  });

  it('a "brought forward" line after a transaction (a page carry-forward) is not the opening balance', () => {
    expect(openingBalanceIndexes([
      { date: '2026-01-01', reference: null, description: 'Balance brought forward' },
      { date: '2026-02-05', reference: 'INV-1', description: 'Tax invoice' },
      { date: '2026-03-01', reference: null, description: 'Balance brought forward' },
      { date: '2026-03-05', reference: 'INV-2', description: 'Tax invoice' },
    ])).toEqual(new Set([0]));
  });

  it('order does not decide it: a carry-forward listed first but dated after a transaction is not one', () => {
    expect(openingBalanceIndexes([
      { date: '2026-03-01', reference: null, description: 'Brought forward' },
      { date: '2026-02-05', reference: 'INV-1', description: 'Tax invoice' },
    ])).toEqual(new Set());
  });

  it('an undated line is never the opening balance', () => {
    expect(openingBalanceIndexes([
      { date: null, reference: null, description: 'Balance brought forward' },
      { date: '2026-02-05', reference: 'INV-1', description: 'Tax invoice' },
    ])).toEqual(new Set());
  });

  it('a B/F dated the same day as the first transaction still qualifies', () => {
    expect(openingBalanceIndexes([
      { date: '2026-02-05', reference: null, description: 'Opening balance' },
      { date: '2026-02-05', reference: 'INV-1', description: 'Tax invoice' },
    ])).toEqual(new Set([0]));
  });
});

describe('openingBalanceAsAt', () => {
  it('is the day before the first dated transaction line', () => {
    const lines = [
      { date: '2026-01-01', reference: null, description: 'Balance brought forward' },
      { date: '2026-03-01', reference: 'INV-1', description: 'Tax invoice' },
      { date: '2026-02-05', reference: 'INV-2', description: 'Tax invoice' },
    ];
    expect(openingBalanceAsAt(lines, openingBalanceIndexes(lines), '2026-10-31')).toBe('2026-02-04');
  });

  it('crosses a month and a year boundary', () => {
    const lines = [
      { date: '2025-12-31', reference: null, description: 'Opening balance' },
      { date: '2026-01-01', reference: 'INV-1', description: 'Tax invoice' },
    ];
    expect(openingBalanceAsAt(lines, openingBalanceIndexes(lines), '2026-10-31')).toBe('2025-12-31');
  });

  it('with no transaction line it is the statement date', () => {
    const lines = [{ date: '2026-01-01', reference: null, description: 'Opening balance' }];
    expect(openingBalanceAsAt(lines, openingBalanceIndexes(lines), '2026-10-31')).toBe('2026-10-31');
  });
});

describe('buildInserts with an opening-balance line', () => {
  const invoices: InvoiceRecord[] = [
    // Same amount and date as the B/F line: a fuzzy match would claim it.
    { id: 'inv-bf-lookalike', invoiceNumber: 'X-1', invoiceDate: '2026-01-01', totalAmount: 1000 },
    { id: 'inv-1', invoiceNumber: 'INV-1', invoiceDate: '2026-02-05', totalAmount: 500 },
  ];

  it('the B/F line is never matched and never missing; the transactions match as before', () => {
    const { inserts, matchedIds } = buildInserts('r', [
      { date: '2026-01-01', reference: 'X-1', description: 'Balance brought forward', debit: 1000 },
      { date: '2026-02-05', reference: 'INV-1', description: 'Tax invoice', debit: 500 },
    ], invoices);
    expect(inserts[0]).toMatchObject({ matchedInvoiceId: null, matchConfidence: null, mismatchReason: null });
    expect(inserts[1]).toMatchObject({ matchedInvoiceId: 'inv-1', mismatchReason: null });
    expect(matchedIds.has('inv-bf-lookalike')).toBe(false);
    expect(inserts.filter((l) => l.mismatchReason === 'missing_in_isaflow')).toHaveLength(0);
    // The look-alike bill is in the ledger and not on the statement.
    expect(inserts.filter((l) => l.mismatchReason === 'missing_in_statement').map((l) => l.matchedInvoiceId))
      .toEqual(['inv-bf-lookalike']);
  });

  it('a carry-forward line after a transaction is still matched like any other line', () => {
    const { inserts } = buildInserts('r', [
      { date: '2026-01-01', reference: null, description: 'Opening balance', debit: 0 },
      { date: '2026-02-05', reference: 'INV-1', description: 'Tax invoice', debit: 500 },
      { date: '2026-03-01', reference: null, description: 'Balance brought forward', debit: 777 },
    ], invoices);
    expect(inserts[2]).toMatchObject({ mismatchReason: 'missing_in_isaflow' });
  });
});
