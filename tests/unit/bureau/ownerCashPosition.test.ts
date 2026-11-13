// tests/unit/bureau/ownerCashPosition.test.ts
import { describe, it, expect } from 'vitest';
import {
  pickPayrollRun,
  shapePayrollAffordability,
  shapeVatSetAside,
  type PayrollRunRow,
} from '@/modules/bureau/services/ownerCashPositionService';

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

describe('pickPayrollRun', () => {
  const zero = { total_net: '0', total_paye: '0', total_uif: '0', total_sdl: '0', total_eti: '0' };
  const prev = run({ id: 'prev', period_month: 5, total_net: '300', total_paye: '100', total_uif: '0', total_sdl: '0', total_eti: '0' });
  const cur = run({ id: 'cur', period_month: 6, total_net: '4000', total_paye: '1000', total_uif: '0', total_sdl: '0', total_eti: '0' });

  it('reports this month when last month is covered and this month is short', () => {
    const p = pickPayrollRun([prev, cur], 1000);
    expect(p).toMatchObject({ runId: 'cur', canPay: false, shortfall: 4000 });
  });

  it('reports the earliest short run when both are short', () => {
    expect(pickPayrollRun([prev, cur], 100)!.runId).toBe('prev');
  });

  it('a draft with no totals does not hide a shortfall on the other run', () => {
    expect(pickPayrollRun([run({ id: 'draft', period_month: 5, ...zero }), cur], 1000)!.runId).toBe('cur');
  });

  it('when every run is covered, reports the latest run with totals', () => {
    expect(pickPayrollRun([prev, run({ id: 'draft', ...zero })], 1000)).toMatchObject({ runId: 'prev', canPay: true });
  });

  it('falls back to the earliest run when none has totals, and null for none', () => {
    expect(pickPayrollRun([run({ id: 'a', ...zero }), run({ id: 'b', ...zero })], 0)!.runId).toBe('a');
    expect(pickPayrollRun([], 0)).toBeNull();
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
