// tests/unit/bureau/ownerCashPosition.test.ts
import { describe, it, expect } from 'vitest';
import {
  shapePayrollAffordability,
  shapeTopDebtors,
  shapeVatSetAside,
  type PayrollRunRow,
} from '@/modules/bureau/services/ownerCashPositionService';
import type { DebtorSummary } from '@/modules/accounting/services/ar/debtorsManagerService';

const run = (over: Partial<PayrollRunRow> = {}): PayrollRunRow => ({
  id: 'run-1', period_month: 6, period_year: 2026, status: 'approved',
  total_net: '90000', total_paye: '14000', total_uif: '1800', total_sdl: '1000', total_eti: '800',
  ...over,
});

describe('shapePayrollAffordability', () => {
  it('computes required = net + paye + uif + sdl − eti and canPay when cash covers it', () => {
    const p = shapePayrollAffordability(run(), 150000);
    expect(p).toEqual({
      runId: 'run-1', periodLabel: 'June 2026', status: 'approved',
      totalRequired: 106000, canPay: true, shortfall: 0,
    });
  });

  it('canPay is true at exact boundary (cash === required)', () => {
    expect(shapePayrollAffordability(run(), 106000)!.canPay).toBe(true);
  });

  it('reports shortfall when cash is short', () => {
    const p = shapePayrollAffordability(run(), 100000);
    expect(p!.canPay).toBe(false);
    expect(p!.shortfall).toBe(6000);
  });

  it('labels draft/calculated runs as estimated', () => {
    expect(shapePayrollAffordability(run({ status: 'calculated' }), 0)!.status).toBe('estimated');
    expect(shapePayrollAffordability(run({ status: 'draft' }), 0)!.status).toBe('estimated');
  });

  it('returns null when there is no run', () => {
    expect(shapePayrollAffordability(null, 100)).toBeNull();
  });

  it('handles pg numeric strings and zero eti', () => {
    const p = shapePayrollAffordability(run({ total_eti: '0' }), 0);
    expect(p!.totalRequired).toBe(106800);
  });
});

describe('shapeTopDebtors', () => {
  const d = (name: string, total: number, d30 = 0, d90p = 0): DebtorSummary => ({
    clientId: `c-${name}`, clientName: name,
    current: total - d30 - d90p, days30: d30, days60: 0, days90: 0, days90Plus: d90p,
    totalOutstanding: total, invoiceCount: 1,
  });

  it('takes top 3 and sums overdue buckets', () => {
    const out = shapeTopDebtors([d('A', 50000, 10000, 5000), d('B', 30000), d('C', 20000), d('D', 10)]);
    expect(out.topDebtors).toHaveLength(3);
    expect(out.topDebtors[0]).toEqual({ clientId: 'c-A', clientName: 'A', totalOutstanding: 50000, overdue: 15000 });
    expect(out.arTotal).toBe(100010); // includes the 4th debtor
  });

  it('handles empty list', () => {
    expect(shapeTopDebtors([])).toEqual({ topDebtors: [], arTotal: 0 });
  });
});

describe('shapeVatSetAside', () => {
  it('shapes a bi-monthly period label with netVat', () => {
    const v = shapeVatSetAside(23000, { periodStart: '2026-05-01', periodEnd: '2026-06-30', dueDate: '2026-07-25' });
    expect(v).toEqual({ periodLabel: 'May–Jun 2026', dueDate: '2026-07-25', netVat: 23000 });
  });

  it('shapes a monthly period label', () => {
    const v = shapeVatSetAside(-500, { periodStart: '2026-06-01', periodEnd: '2026-06-30', dueDate: '2026-07-25' });
    expect(v.periodLabel).toBe('Jun 2026');
    expect(v.netVat).toBe(-500);
  });

  it('labels a cross-year bi-monthly period with the end year', () => {
    const v = shapeVatSetAside(100, { periodStart: '2025-12-01', periodEnd: '2026-01-31', dueDate: '2026-02-25' });
    expect(v.periodLabel).toBe('Dec–Jan 2026');
  });
});
