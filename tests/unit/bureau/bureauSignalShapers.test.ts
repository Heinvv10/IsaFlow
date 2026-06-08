import { describe, it, expect } from 'vitest';
import {
  shapeUnreconciled,
  shapeBillsToApprove,
  type CompanyMeta,
} from '@/modules/bureau/services/bureauWorkAggregatorService';

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

  it('treats a null due date as info and drops unknown companies', () => {
    const items = shapeBillsToApprove(
      [{ company_id: 'c1', cnt: 1, earliest_due: null }, { company_id: 'x', cnt: 5, earliest_due: null }],
      meta, today,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.severity).toBe('info');
    expect(items[0]!.dueAt).toBeNull();
  });
});
