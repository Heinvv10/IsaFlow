/**
 * The pack's Cash Flow, Debtors/Creditors Ageing and Bank Reconciliation sections: the reports' own figures,
 * cell for cell, as the pack prints them. (The same cells against the services on real PostgreSQL:
 * tests/integration/management-pack-reports.int.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import type { AgingReport } from '@/modules/accounting/services/reports/agingReportService';
import type { CashFlowDirectReport } from '@/modules/accounting/services/afs/cashFlowDirectService';
import type { BankReconciliation } from '@/modules/accounting/types/bank.types';
import type { NoteContentTable } from '@/modules/accounting/services/afs/afsTypes';
import {
  AGEING_TOP, ageingBlocks, ageingFigures, bankReconciliationBlocks, cashFlowBlocks, cashFlowFigures, latestReconciliations,
} from '@/modules/accounting/services/afs/managementPackReportSections';

const plain = (s: string) => s.replace(/ /g, ' ');
const tableOf = (blocks: ReturnType<typeof cashFlowBlocks>): NoteContentTable => {
  const t = blocks.find((b): b is NoteContentTable => b.type === 'table');
  if (!t) throw new Error('no table');
  return { ...t, rows: t.rows.map((r) => r.map(plain)) };
};
const texts = (blocks: ReturnType<typeof cashFlowBlocks>) => blocks.flatMap((b) => (b.type === 'paragraph' ? [plain(b.text)] : []));

const cash = (over: Partial<CashFlowDirectReport> = {}): CashFlowDirectReport => ({
  periodStart: '2026-09-01', periodEnd: '2026-09-30', openingCash: 1000,
  operatingItems: [{ cashGroup: 'cash_received_from_customers', label: 'Cash received from customers', amount: 5000 }, { cashGroup: 'cash_paid_to_suppliers', label: 'Cash paid to suppliers', amount: -2000 }],
  operatingTotal: 3000, investingItems: [{ cashGroup: 'investing', label: 'Net investing cash flows', amount: -500 }], investingTotal: -500,
  financingItems: [], financingTotal: 0, netChange: 2500, closingCash: 3500, ...over,
});

describe('cash flow', () => {
  it('prints the report\'s groups, items and totals, opening to closing', () => {
    const t = tableOf(cashFlowBlocks([{ label: 'This month', report: cash() }], false));
    expect(t.headers).toEqual(['', 'This month']);
    expect(t.rows).toEqual([
      ['Opening cash', 'R 1 000.00'],
      ['Operating activities', ''], ['Cash received from customers', 'R 5 000.00'], ['Cash paid to suppliers', '−R 2 000.00'], ['Net cash from operating activities', 'R 3 000.00'],
      ['Investing activities', ''], ['Net investing cash flows', '−R 500.00'], ['Net cash from investing activities', '−R 500.00'],
      ['Net change in cash', 'R 2 500.00'], ['Closing cash', 'R 3 500.00'],
    ]);
    expect(t.rowKinds).toEqual(['subtotal', 'heading', 'line', 'line', 'subtotal', 'heading', 'line', 'subtotal', 'subtotal', 'total']);
  });

  it('uses the report\'s closing cash, never a sum of its own', () => {
    expect(tableOf(cashFlowBlocks([{ label: 'x', report: cash({ closingCash: 1 }) }], false)).rows.at(-1)).toEqual(['Closing cash', 'R 1.00']);
  });

  it('adds the prior month and the same month last year with the change', () => {
    const t = tableOf(cashFlowBlocks([
      { label: 'This month', report: cash() }, { label: 'Prior month', report: cash({ openingCash: 0, closingCash: 900 }) },
      { label: 'Same month last year', report: cash({ closingCash: 3000, openingCash: 800 }) },
    ], true));
    expect(t.headers).toEqual(['', 'This month', 'Prior month', 'Same month last year', 'Change on last year']);
    expect(t.rows.at(-1)).toEqual(['Closing cash', 'R 3 500.00', 'R 900.00', 'R 3 000.00', 'R 500.00']);
  });

  it('a month in which no cash moved says so, and still shows opening and closing', () => {
    const none = cash({ operatingItems: [], operatingTotal: 0, investingItems: [], investingTotal: 0, netChange: 0, closingCash: 1000 });
    const blocks = cashFlowBlocks([{ label: 'This month', report: none }], false);
    expect(texts(blocks)).toEqual(['No cash moved in this period.']);
    expect(tableOf(blocks).rows.map((r) => r[0])).toEqual(['Opening cash', 'Net change in cash', 'Closing cash']);
  });

  it('the figures behind it are the report\'s totals', () => {
    expect(cashFlowFigures(cash())).toMatchObject({ openingCash: 1000, operatingTotal: 3000, netChange: 2500, closingCash: 3500 });
    expect(cashFlowFigures(undefined)).toEqual({});
  });
});

const bucket = (name: string, total: number, over: Record<string, number> = {}) => ({
  entityId: name, entityName: name, current: total, days30: 0, days60: 0, days90: 0, days120Plus: 0, total, ...over,
});
const aging = (buckets: ReturnType<typeof bucket>[], over: Partial<AgingReport> = {}): AgingReport => {
  const sum = (k: 'current' | 'days30' | 'days60' | 'days90' | 'days120Plus' | 'total') => buckets.reduce((s, b) => s + b[k], 0);
  return {
    asAt: '2026-09-30', buckets, totals: { current: sum('current'), days30: sum('days30'), days60: sum('days60'), days90: sum('days90'), days120Plus: sum('days120Plus'), disputed: 0, total: sum('total') },
    excluded: [], excludedTotal: 0, entityUniverse: buckets.length, unappliedReceipts: 0, subledgerTotal: sum('total'), postedThrough: null, ...over,
  };
};

describe('ageing', () => {
  it('lists the balances by size and ends on the report\'s own totals row', () => {
    const report = aging([bucket('Small', 100), bucket('Big', 900, { current: 400, days30: 300, days60: 200 })]);
    const t = tableOf(ageingBlocks(report, 'ar'));
    expect(t.headers).toEqual(['Customer', 'Current', '30 days', '60 days', '90 days', '120+ days', 'Total']);
    expect(t.rows).toEqual([
      ['Big', 'R 400.00', 'R 300.00', 'R 200.00', 'R 0.00', 'R 0.00', 'R 900.00'],
      ['Small', 'R 100.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 100.00'],
      ['Total', 'R 500.00', 'R 300.00', 'R 200.00', 'R 0.00', 'R 0.00', 'R 1 000.00'],
    ]);
    expect(t.rowKinds).toEqual(['line', 'line', 'total']);
  });

  it('uses the report\'s totals row, not a sum of the rows printed', () => {
    const report = aging([bucket('A', 100)], { totals: { current: 7, days30: 0, days60: 0, days90: 0, days120Plus: 0, disputed: 0, total: 7 } });
    expect(tableOf(ageingBlocks(report, 'ap')).rows.at(-1)).toEqual(['Total', 'R 7.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 0.00', 'R 7.00']);
  });

  it('folds the balances beyond the largest ten into one row that still foots to the total', () => {
    const many = Array.from({ length: AGEING_TOP + 3 }, (_, i) => bucket(`C${String(i).padStart(2, '0')}`, 1000 - i));
    const report = aging(many);
    const t = tableOf(ageingBlocks(report, 'ar'));
    expect(t.rows).toHaveLength(AGEING_TOP + 2);
    expect(t.rows[AGEING_TOP]?.[0]).toBe('Other customers (3)');
    const total = (r: string[] | undefined) => Number((r?.[6] ?? '').replace(/[^\d.]/g, ''));
    expect(total(t.rows[AGEING_TOP])).toBeCloseTo(many.slice(AGEING_TOP).reduce((s, b) => s + b.total, 0), 2);
    expect(texts(ageingBlocks(report, 'ar'))).toEqual([`${many.length} customers have a balance; the ${AGEING_TOP} largest are listed.`]);
  });

  it('suppliers, and the words for what the report could not age and left unapplied', () => {
    const report = aging([bucket('S', 500)], {
      excluded: [{ id: 'x', reason: 'null_due_date', detail: '', amount: 120, documentNumber: 'INV1', entityName: 'S' }], excludedTotal: 120, unappliedReceipts: 75,
    });
    const blocks = ageingBlocks(report, 'ap');
    expect(tableOf(blocks).headers[0]).toBe('Supplier');
    expect(texts(blocks)).toEqual(['1 document has no due date and cannot be aged: R 120.00, not in the columns above.', 'Unapplied payments on the control account: R 75.00.']);
    expect(texts(ageingBlocks(report, 'ar')).at(-1)).toBe('Unapplied receipts on the control account: R 75.00.');
  });

  it('a Disputed column only when debtors have disputes', () => {
    const report = aging([bucket('A', 100, { disputed: 30 })]);
    report.totals.disputed = 30;
    const t = tableOf(ageingBlocks(report, 'ar'));
    expect(t.headers.at(-1)).toBe('Disputed');
    expect(t.rows.at(-1)?.at(-1)).toBe('R 30.00');
    expect(tableOf(ageingBlocks(aging([bucket('A', 100)]), 'ar')).headers).not.toContain('Disputed');
  });

  it('no balances prints a sentence with the date, not an empty table', () => {
    expect(texts(ageingBlocks(aging([]), 'ar'))).toEqual(['No open customer balances at 30 September 2026.']);
    expect(texts(ageingBlocks(aging([]), 'ap'))).toEqual(['No open supplier balances at 30 September 2026.']);
  });

  it('the figures behind it', () => {
    expect(ageingFigures(aging([bucket('A', 100), bucket('B', 300)]))).toMatchObject({ asAt: '2026-09-30', entities: 2, largest: [{ name: 'B', total: 300 }, { name: 'A', total: 100 }] });
    expect(ageingFigures(undefined)).toEqual({});
  });
});

const rec = (over: Partial<BankReconciliation>): BankReconciliation => ({
  id: 'r', bankAccountId: 'a', statementDate: '2026-09-30', statementBalance: 1000, glBalance: 1000, reconciledBalance: 1000, difference: 0,
  status: 'completed', startedBy: 'u', startedAt: '2026-10-01', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01', bankAccountName: 'Main', ...over,
});

describe('bank reconciliation', () => {
  it('the latest session of each account on or before the month end, never a later one', () => {
    const all = [
      rec({ id: '1', statementDate: '2026-08-31' }), rec({ id: '2', statementDate: '2026-09-30', difference: 5 }), rec({ id: '3', statementDate: '2026-10-31' }),
      rec({ id: '4', bankAccountId: 'b', bankAccountName: 'Savings', statementDate: '2026-09-15', status: 'in_progress', difference: 12.5 }),
    ];
    expect(latestReconciliations(all, '2026-09-30').map((r) => r.id)).toEqual(['2', '4']);
    const t = tableOf(bankReconciliationBlocks(all, '2026-09-30'));
    expect(t.headers).toEqual(['Bank account', 'Statement date', 'Statement balance', 'GL balance', 'Difference', 'Status']);
    expect(t.rows).toEqual([
      ['Main', '30 September 2026', 'R 1 000.00', 'R 1 000.00', 'R 5.00', 'Completed'],
      ['Savings', '15 September 2026', 'R 1 000.00', 'R 1 000.00', 'R 12.50', 'In progress'],
    ]);
  });

  it('no session up to the month end says so, with the date', () => {
    expect(texts(bankReconciliationBlocks([rec({ statementDate: '2026-10-31' })], '2026-09-30'))).toEqual(['No bank account has a reconciliation dated on or before 30 September 2026.']);
    expect(texts(bankReconciliationBlocks([], '2026-09-30'))).toHaveLength(1);
  });

  it('two sessions on one date: the later created wins', () => {
    const all = [rec({ id: 'old', createdAt: '2026-10-01T00:00:00Z' }), rec({ id: 'new', createdAt: '2026-10-02T00:00:00Z' })];
    expect(latestReconciliations(all, '2026-09-30').map((r) => r.id)).toEqual(['new']);
  });
});
