import { describe, it, expect } from 'vitest';
import {
  shapeUnreconciled,
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
