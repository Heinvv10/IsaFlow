/**
 * Merging the per-page reads of a statement: rows in page order, header fields
 * from the first page that has them, the opening balance from the front and the
 * closing balance from the back, and (bank only) a warning when the rows do not
 * walk the opening balance to the closing one.
 */
import { describe, expect, it } from 'vitest';
import type { ExtractedBankStatement, ExtractedBankTransaction } from '@/modules/accounting/types/documentCapture.types';
import type { SupplierStatementExtraction } from '@/modules/accounting/services/bank/vlmSupplierStatementService';
import { mergeBankPages, mergeSupplierPages } from '@/modules/accounting/services/bank/vlmStatementMerge';

const tx = (description: string, amount: number, date = '2026-03-05'): ExtractedBankTransaction => (
  { date, description, amount, balance: null, reference: null, transactionType: null });

function bankPage(over: Partial<ExtractedBankStatement> = {}): ExtractedBankStatement {
  return {
    bankName: null, accountNumber: null, statementPeriod: null, openingBalance: null, closingBalance: null,
    transactions: [], confidence: 0.85, warnings: [], ...over,
  };
}

describe('mergeBankPages', () => {
  it('keeps the rows in page order', () => {
    const merged = mergeBankPages([
      bankPage({ transactions: [tx('a', -1), tx('b', -2)] }),
      bankPage({ transactions: [tx('c', -3)] }),
      bankPage({ transactions: [tx('d', -4), tx('e', -5)] }),
    ]);
    expect(merged.transactions.map((t) => t.description)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('takes bank name and account number from the first page that has one', () => {
    const merged = mergeBankPages([
      bankPage(),
      bankPage({ bankName: 'FNB', accountNumber: '111' }),
      bankPage({ bankName: 'Other', accountNumber: '222' }),
    ]);
    expect(merged.bankName).toBe('FNB');
    expect(merged.accountNumber).toBe('111');
  });

  it('takes the opening balance from the first page that has one and the closing balance from the last', () => {
    const merged = mergeBankPages([
      bankPage({ openingBalance: 1000, closingBalance: 111 }),
      bankPage({ openingBalance: 555, closingBalance: 222 }),
      bankPage({ closingBalance: 333 }),
      bankPage(),
    ]);
    expect(merged.openingBalance).toBe(1000);
    expect(merged.closingBalance).toBe(333);
  });

  it('keeps a zero balance rather than treating it as missing', () => {
    const merged = mergeBankPages([bankPage({ openingBalance: 0 }), bankPage({ openingBalance: 50, closingBalance: 0 }), bankPage({ closingBalance: 9 })]);
    expect(merged.openingBalance).toBe(0);
    expect(mergeBankPages([bankPage({ closingBalance: 9 }), bankPage({ closingBalance: 0 })]).closingBalance).toBe(0);
  });

  it('spans the earliest period start to the latest period end', () => {
    const merged = mergeBankPages([
      bankPage({ statementPeriod: { from: '2026-03-01', to: '2026-03-31' } }),
      bankPage({ statementPeriod: { from: '2026-03-15', to: null } }),
      bankPage({ statementPeriod: { from: null, to: '2026-04-02' } }),
      bankPage({ statementPeriod: null }),
    ]);
    expect(merged.statementPeriod).toEqual({ from: '2026-03-01', to: '2026-04-02' });
  });

  it('has no period when no page printed one', () => {
    expect(mergeBankPages([bankPage(), bankPage()]).statementPeriod).toBeNull();
  });

  it('pools the pages\' warnings once each', () => {
    const merged = mergeBankPages([
      bankPage({ warnings: ['blurry', 'x'], transactions: [tx('a', 1)] }),
      bankPage({ warnings: ['blurry'], transactions: [tx('b', 1)] }),
    ]);
    expect(merged.warnings).toEqual(['blurry', 'x']);
  });

  it('says so once, and only when no page had a transaction', () => {
    expect(mergeBankPages([bankPage(), bankPage()]).warnings).toContain('No transactions extracted from bank statement');
    expect(mergeBankPages([bankPage(), bankPage({ transactions: [tx('a', 1)] })]).warnings)
      .not.toContain('No transactions extracted from bank statement');
  });

  it('scores a statement with rows 0.85 and one without 0.1', () => {
    expect(mergeBankPages([bankPage({ transactions: [tx('a', 1)] })]).confidence).toBe(0.85);
    expect(mergeBankPages([bankPage()]).confidence).toBe(0.1);
  });

  describe('balance continuity', () => {
    const continuity = (w: string[]) => w.filter((x) => x.startsWith('Balance check'));

    it('is silent when opening + rows = closing', () => {
      const merged = mergeBankPages([
        bankPage({ openingBalance: 1000, transactions: [tx('a', -200.1), tx('b', 50.05)] }),
        bankPage({ closingBalance: 849.95, transactions: [tx('c', 0)] }),
      ]);
      expect(continuity(merged.warnings)).toEqual([]);
    });

    it('is silent within a cent of rounding', () => {
      const merged = mergeBankPages([
        bankPage({ openingBalance: 100, closingBalance: 110.01, transactions: [tx('a', 10)] }),
      ]);
      expect(continuity(merged.warnings)).toEqual([]);
    });

    it('warns, naming both figures, when a row has gone missing', () => {
      const merged = mergeBankPages([
        bankPage({ openingBalance: 1000, transactions: [tx('a', -200)] }),
        bankPage({ closingBalance: 500, transactions: [tx('b', -100)] }),
      ]);
      expect(continuity(merged.warnings)).toEqual([
        'Balance check: the opening balance 1000.00 plus the 2 transactions read (-300.00) is 700.00, '
        + 'but the closing balance is 500.00 — a transaction may be missing or misread.',
      ]);
    });

    it('warns on a difference of two cents', () => {
      const merged = mergeBankPages([bankPage({ openingBalance: 100, closingBalance: 110.02, transactions: [tx('a', 10)] })]);
      expect(continuity(merged.warnings)).toHaveLength(1);
    });

    it('does not warn when either balance is unknown', () => {
      expect(continuity(mergeBankPages([bankPage({ openingBalance: 100, transactions: [tx('a', 5)] })]).warnings)).toEqual([]);
      expect(continuity(mergeBankPages([bankPage({ closingBalance: 100, transactions: [tx('a', 5)] })]).warnings)).toEqual([]);
    });

    it('still checks a statement whose opening balance is zero', () => {
      const merged = mergeBankPages([bankPage({ openingBalance: 0, closingBalance: 5, transactions: [tx('a', 9)] })]);
      expect(continuity(merged.warnings)).toHaveLength(1);
    });
  });
});

const line = (reference: string, debit?: number, date?: string) => ({ reference, debit, date });

function supplierPage(over: Partial<SupplierStatementExtraction> = {}): SupplierStatementExtraction {
  return { lines: [], warnings: [], ...over };
}

describe('mergeSupplierPages', () => {
  it('keeps the lines in page order', () => {
    const merged = mergeSupplierPages([
      supplierPage({ lines: [line('INV1', 10), line('INV2', 20)] }),
      supplierPage({ lines: [line('INV3', 30)] }),
    ]);
    expect(merged.lines.map((l) => l.reference)).toEqual(['INV1', 'INV2', 'INV3']);
  });

  it('takes name and statement date from the first page that has one', () => {
    const merged = mergeSupplierPages([
      supplierPage(),
      supplierPage({ supplierName: 'Acme', statementDate: '2026-03-31' }),
      supplierPage({ supplierName: 'Other', statementDate: '2026-04-30' }),
    ]);
    expect(merged.supplierName).toBe('Acme');
    expect(merged.statementDate).toBe('2026-03-31');
  });

  it('takes the opening balance from the front and the closing balance from the back', () => {
    const merged = mergeSupplierPages([
      supplierPage({ openingBalance: 100, closingBalance: 1 }),
      supplierPage({ openingBalance: 7, closingBalance: 2 }),
      supplierPage({ closingBalance: 300 }),
      supplierPage(),
    ]);
    expect(merged.openingBalance).toBe(100);
    expect(merged.closingBalance).toBe(300);
  });

  it('spans the earliest period start to the latest period end', () => {
    const merged = mergeSupplierPages([
      supplierPage({ periodStart: '2026-03-10', periodEnd: '2026-03-31' }),
      supplierPage({ periodStart: '2026-03-01' }),
      supplierPage({ periodEnd: '2026-04-05' }),
    ]);
    expect(merged.periodStart).toBe('2026-03-01');
    expect(merged.periodEnd).toBe('2026-04-05');
  });

  it('leaves absent fields undefined', () => {
    const merged = mergeSupplierPages([supplierPage(), supplierPage()]);
    expect(merged.supplierName).toBeUndefined();
    expect(merged.periodStart).toBeUndefined();
    expect(merged.openingBalance).toBeUndefined();
    expect(merged.closingBalance).toBeUndefined();
  });

  it('pools warnings once each, and adds "No lines" only when no page had a line', () => {
    const merged = mergeSupplierPages([supplierPage({ warnings: ['w'] }), supplierPage({ warnings: ['w'] })]);
    expect(merged.warnings).toEqual(['w', 'No lines extracted from supplier statement']);
    expect(mergeSupplierPages([supplierPage({ lines: [line('A', 1)] }), supplierPage()]).warnings).toEqual([]);
  });
});
