/**
 * rowLabel(tx): the row-scoped part of every bank grid control's accessible name, "{date} {description} {amount}",
 * so 25 "VAT" selects on a page are told apart by the row they belong to.
 */
import { describe, it, expect } from 'vitest';
import { rowLabel, rowLabels } from '@/components/accounting/bankTx/bankTxRowLabel';
import type { BankTx } from '@/components/accounting/bankTx/bankTxTypes';

const NB = ' ';
const MINUS = '−';
const tx = (over: Partial<BankTx>): BankTx => ({ id: 'x', transactionDate: '2026-06-01', amount: 0, status: 'imported', ...over });

describe('rowLabel', () => {
  it.each([
    [tx({ description: 'WOOLWORTHS SANDTON', amount: -1234.5 }), `01 Jun 2026 WOOLWORTHS SANDTON ${MINUS}R${NB}1${NB}234.50`],
    [tx({ description: 'Client payment', amount: 500, transactionDate: '2026-12-31' }), `31 Dec 2026 Client payment R${NB}500.00`],
    [tx({ description: '  padded   text ', amount: 1 }), `01 Jun 2026 padded text R${NB}1.00`],
    [tx({ description: undefined, amount: -2 }), `01 Jun 2026 No description ${MINUS}R${NB}2.00`],
    [tx({ description: '', amount: -2 }), `01 Jun 2026 No description ${MINUS}R${NB}2.00`],
  ])('%#', (t, want) => {
    expect(rowLabel(t)).toBe(want);
  });

  it('accepts a Date-shaped transactionDate from pg', () => {
    expect(rowLabel(tx({ transactionDate: new Date('2026-03-05T00:00:00') as unknown as string, description: 'x', amount: 1 })))
      .toBe(`05 Mar 2026 x R${NB}1.00`);
  });
  it('caps a long description at 60 characters, so 25 rows of names stay listenable', () => {
    const long = 'PAYMENT TO A VERY LONG MERCHANT NAME THAT GOES ON AND ON FOR A WHILE REF 0000123456';
    expect(rowLabel(tx({ description: long, amount: 1 }))).toBe(`01 Jun 2026 ${long.slice(0, 59)}… R${NB}1.00`);
    const exact = 'x'.repeat(60);
    expect(rowLabel(tx({ description: exact, amount: 1 }))).toBe(`01 Jun 2026 ${exact} R${NB}1.00`);
  });
});

describe('rowLabels', () => {
  it('numbers rows whose labels collide by their position on the page, and leaves unique ones alone', () => {
    const rows = [
      tx({ id: 'p', description: 'FEE', amount: -5 }),
      tx({ id: 'q', description: 'Other', amount: -5 }),
      tx({ id: 'r', description: 'FEE', amount: -5 }),
    ];
    const labels = rowLabels(rows);
    expect(labels.get('p')).toBe(`01 Jun 2026 FEE ${MINUS}R${NB}5.00 (row 1)`);
    expect(labels.get('q')).toBe(`01 Jun 2026 Other ${MINUS}R${NB}5.00`);
    expect(labels.get('r')).toBe(`01 Jun 2026 FEE ${MINUS}R${NB}5.00 (row 3)`);
    expect(new Set(labels.values()).size).toBe(3);
  });
});
