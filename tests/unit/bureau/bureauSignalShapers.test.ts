import { describe, it, expect } from 'vitest';
import {
  shapeUnreconciled,
  shapeBillsToApprove,
  reduceMonthEnd,
  type CompanyMeta,
} from '@/modules/bureau/services/bureauWorkAggregatorService';
import { shapeVatDue } from '@/modules/bureau/services/bureauVatSignal';

const meta = new Map<string, CompanyMeta>([
  ['c1', { bureau_id: 'b1', bureau_name: 'Acme Books', company_id: 'c1', company_name: 'Client One' }],
]);

describe('shapeUnreconciled', () => {
  it('emits one info item per company with unreconciled txns', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 14 }], meta);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      companyId: 'c1', companyName: 'Client One', task: 'Bank reconciliation',
      detail: '14 unreconciled', severity: 'info', href: '/accounting/reports/bank-transactions',
    });
  });

  it('drops rows whose company_id is not in the bureau meta map (tenant guard)', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 3 }, { company_id: 'rogue', cnt: 9 }], meta);
    expect(items).toHaveLength(1);
    expect(items[0]!.companyId).toBe('c1');
  });

  it('skips companies with zero unreconciled', () => {
    expect(shapeUnreconciled([{ company_id: 'c1', cnt: 0 }], meta)).toHaveLength(0);
  });

  it('coerces a string cnt from the pg driver correctly', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: '7' }], meta);
    expect(items[0]!.detail).toBe('7 unreconciled');
  });

  it('sets amount from amount_total (total unreconciled value)', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 14, amount_total: 48230.75 }], meta);
    expect(items[0]!.amount).toBe(48230.75);
  });

  it('coerces a string amount_total from the pg driver', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 7, amount_total: '1200.00' }], meta);
    expect(items[0]!.amount).toBe(1200);
  });

  it('sets amount to null when amount_total is absent', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 3 }], meta);
    expect(items[0]!.amount).toBeNull();
  });

  it('sets amount to null when amount_total is non-numeric (NaN guard)', () => {
    const items = shapeUnreconciled([{ company_id: 'c1', cnt: 5, amount_total: 'not-a-number' }], meta);
    expect(items[0]!.amount).toBeNull();
  });
});

describe('shapeBillsToApprove', () => {
  const today = new Date('2026-06-08T00:00:00Z');

  it('flags overdue when the earliest due date is in the past', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 9, earliest_due: '2026-06-01' }], meta, today);
    expect(items[0]).toMatchObject({
      task: 'Bills to approve', detail: '9 awaiting approval', severity: 'overdue',
      href: '/accounting/reports/ap-aging', dueAt: '2026-06-01',
    });
  });

  it('flags due_soon within 7 days and info beyond', () => {
    const soon = shapeBillsToApprove([{ company_id: 'c1', cnt: 2, earliest_due: '2026-06-12' }], meta, today);
    expect(soon[0]!.severity).toBe('due_soon');
    const later = shapeBillsToApprove([{ company_id: 'c1', cnt: 2, earliest_due: '2026-07-30' }], meta, today);
    expect(later[0]!.severity).toBe('info');
  });

  it('treats a null due date as info', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 1, earliest_due: null }], meta, today);
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('info');
    expect(items[0]!.dueAt).toBeNull();
  });

  it('drops rows whose company_id is not in the bureau meta map (tenant guard)', () => {
    const items = shapeBillsToApprove([{ company_id: 'x', cnt: 5, earliest_due: null }], meta, today);
    expect(items).toHaveLength(0);
  });

  it('skips companies with zero bills to approve', () => {
    expect(shapeBillsToApprove([{ company_id: 'c1', cnt: 0, earliest_due: null }], meta, today)).toHaveLength(0);
  });

  it('coerces a string cnt from the pg driver correctly', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: '4', earliest_due: null }], meta, today);
    expect(items[0]!.detail).toBe('4 awaiting approval');
  });

  it('sets amount from amount_total (total value awaiting approval)', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 3, earliest_due: null, amount_total: 12500.5 }], meta, today);
    expect(items[0]!.amount).toBe(12500.5);
  });

  it('coerces a string amount_total from the pg driver', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 2, earliest_due: null, amount_total: '900.00' }], meta, today);
    expect(items[0]!.amount).toBe(900);
  });

  it('sets amount to null when amount_total is absent', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 1, earliest_due: null }], meta, today);
    expect(items[0]!.amount).toBeNull();
  });

  it('sets amount to null when amount_total is non-numeric (NaN guard)', () => {
    const items = shapeBillsToApprove([{ company_id: 'c1', cnt: 2, earliest_due: null, amount_total: 'oops' }], meta, today);
    expect(items[0]!.amount).toBeNull();
  });
});

describe('shapeVatDue', () => {
  const today = new Date('2026-06-20T00:00:00Z'); // odd → Apr–May 2026 period, due 2026-06-25 (5 days out → due_soon)

  it('emits an item when no return covers the expected period', () => {
    const items = shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd' }], [], meta, today);
    expect(items[0]).toMatchObject({
      task: 'VAT return due', detail: 'Apr–May 2026', dueAt: '2026-06-25',
      href: '/accounting/reports/vat-return', severity: 'due_soon',
    });
  });

  it('suppresses the item when a covering return already exists', () => {
    const returns = [{ company_id: 'c1', period_start: '2026-04-01', period_end: '2026-05-31' }];
    expect(shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd' }], returns, meta, today)).toHaveLength(0);
  });

  it('drops companies not in the bureau meta map (tenant guard)', () => {
    const items = shapeVatDue([{ id: 'rogue', vat_period_alignment: 'odd' }], [], meta, today);
    expect(items).toHaveLength(0);
  });

  it('flags overdue when the due date is in the past', () => {
    const items = shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd' }], [], meta, new Date('2026-07-10T00:00:00Z'));
    expect(items[0]).toMatchObject({ task: 'VAT return due', severity: 'overdue' });
  });

  it('derives the even-alignment period correctly', () => {
    const items = shapeVatDue([{ id: 'c1', vat_period_alignment: 'even' }], [], meta, new Date('2026-06-08T00:00:00Z'));
    expect(items[0]).toMatchObject({ task: 'VAT return due', detail: 'Mar–Apr 2026', dueAt: '2026-05-25', severity: 'overdue' });
  });

  it('monthly (Cat C) vendor gets a one-month period with a single-month label', () => {
    const items = shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd', vat_period: 'monthly' }], [], meta, today);
    expect(items[0]).toMatchObject({ task: 'VAT return due', detail: 'May 2026', dueAt: '2026-06-25' });
  });

  it('a filed one-month return suppresses the monthly vendor item', () => {
    const returns = [{ company_id: 'c1', period_start: '2026-05-01', period_end: '2026-05-31' }];
    const items = shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd', vat_period: 'monthly' }], returns, meta, today);
    expect(items).toHaveLength(0);
  });

  it('treats vat_period case-insensitively (legacy "Monthly" rows)', () => {
    const items = shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd', vat_period: 'Monthly' }], [], meta, today);
    expect(items[0]).toMatchObject({ detail: 'May 2026', dueAt: '2026-06-25' });
  });

  it('legacy "Bi-Monthly" rows keep the bi-monthly period', () => {
    const items = shapeVatDue([{ id: 'c1', vat_period_alignment: 'odd', vat_period: 'Bi-Monthly' }], [], meta, today);
    expect(items[0]).toMatchObject({ detail: 'Apr–May 2026', dueAt: '2026-06-25' });
  });
});

describe('reduceMonthEnd', () => {
  it('counts companies whose latest period is closed/locked', () => {
    const rows = [
      { company_id: 'c1', status: 'closed' },
      { company_id: 'c2', status: 'open' },
      { company_id: 'c3', status: 'locked' },
    ];
    expect(reduceMonthEnd(rows, 4)).toEqual({ closed: 2, total: 4 });
  });

  it('reports zero closed when none are', () => {
    expect(reduceMonthEnd([{ company_id: 'c1', status: 'open' }], 3)).toEqual({ closed: 0, total: 3 });
  });

  it('counts an empty result set as zero closed against the bureau total', () => {
    expect(reduceMonthEnd([], 5)).toEqual({ closed: 0, total: 5 });
  });

  it('reports all closed when every latest period is closed or locked', () => {
    expect(reduceMonthEnd([{ company_id: 'c1', status: 'closed' }, { company_id: 'c2', status: 'locked' }], 2))
      .toEqual({ closed: 2, total: 2 });
  });
});
